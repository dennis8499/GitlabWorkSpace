import { createHash } from 'node:crypto';
import { captureGitProcess } from '../git/gitProcess';
import { projectRemoteMatches } from '../git/cloneService';
import { GitLabClient, gitLabWriteFailureEffect } from '../api/gitLabClient';
import type { GitLabIssue, GitLabIssueDiscussion, GitLabMergeRequest } from '../api/types';
import type { CodexTaskRecord, CodexTaskResult } from './protocol';
import type { CodexDeliveryState, CodexDeliveryStep, CodexDeliveryTargetPreview, CodexIssueDeliverySnapshot } from './deliveryProtocol';
import { implementationCommits, implementationDigest, readWorkflowReport, sameWorkflowPath, verifyManagedExecutionRepository, workflowGit } from './projectWorkflows';

export interface CodexDeliveryOptions {
  client(): Promise<GitLabClient>;
  publishWiki?(record: CodexTaskRecord, check: () => void): Promise<CodexTaskResult>;
  reconcileWiki?(record: CodexTaskRecord, check: () => void): Promise<CodexTaskResult | undefined>;
  networkEnvironment?(record: CodexTaskRecord): Promise<NodeJS.ProcessEnv | undefined>;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const failure = (error: unknown): string => error instanceof Error ? error.message : '成果交付尚未完成。';
const marker = (key: string): string => `<!-- gitlab-workspace:delivery:${key} -->`;
/** A Markdown report must never execute GitLab slash commands as a side effect. */
export function deliveryComment(body: string): string { return body.replace(/^(\s*)\/(?=[a-z][a-z_-]*(?:\s|$))/gim, '$1\\/'); }
const findNote = (rows: readonly GitLabIssueDiscussion[], key: string): number | undefined =>
  rows.flatMap(row => row.notes).find(note => !note.system && note.body.includes(marker(key)))?.id;

/** Compare stable requirements, not GitLab activity caused by references or notes. */
export function issueDeliverySnapshot(issue: GitLabIssue): CodexIssueDeliverySnapshot {
  const positive = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0;
  const assignees = issue.assignees ?? (issue.assignee ? [issue.assignee] : []);
  if (![issue.id, issue.project_id, issue.iid].every(positive) || typeof issue.title !== 'string' || typeof issue.state !== 'string' ||
    issue.description != null && typeof issue.description !== 'string' || !Array.isArray(assignees) || assignees.some(user => !user || !positive(user.id)) ||
    issue.labels !== undefined && (!Array.isArray(issue.labels) || issue.labels.some(label => typeof label !== 'string')) ||
    issue.milestone != null && !positive(issue.milestone.id) || [issue.due_date, issue.start_date, issue.issue_type].some(value => value != null && typeof value !== 'string') ||
    issue.confidential !== undefined && typeof issue.confidential !== 'boolean' || issue.discussion_locked != null && typeof issue.discussion_locked !== 'boolean') throw new Error('無法驗證來源 Issue 的完整內容。');
  const description = issue.description ?? '';
  if (Buffer.byteLength(description, 'utf8') > 128_000) throw new Error('Issue 描述超過 128 KB，請先拆分需求再確認交付。');
  return { id: issue.id, projectId: issue.project_id, iid: issue.iid, title: issue.title, description, state: issue.state,
    labels: [...new Set(issue.labels ?? [])].sort(), assigneeIds: [...new Set(assignees.map(user => user.id))].sort((a, b) => a - b),
    milestoneId: issue.milestone?.id ?? null, dueDate: issue.due_date ?? null, startDate: issue.start_date ?? null,
    confidential: issue.confidential === true, discussionLocked: issue.discussion_locked === true, issueType: issue.issue_type ?? 'issue' };
}
export const issueDeliveryDigest = (snapshot: CodexIssueDeliverySnapshot): string => hash(JSON.stringify(snapshot));
export function issueDeliverySummary(snapshot: CodexIssueDeliverySnapshot, webUrl: string): string {
  return [`來源 Issue：${webUrl}`, `Issue #${snapshot.iid}：${snapshot.title}`, `專案／Issue ID：${snapshot.projectId}／${snapshot.id}`, `狀態：${snapshot.state}`,
    `標籤：${JSON.stringify(snapshot.labels)}`, `指派帳號 ID：${JSON.stringify(snapshot.assigneeIds)}`, `Milestone ID：${snapshot.milestoneId ?? '無'}`,
    `開始／到期日：${snapshot.startDate ?? '無'}／${snapshot.dueDate ?? '無'}`, `機密：${snapshot.confidential ? '是' : '否'}；討論鎖定：${snapshot.discussionLocked ? '是' : '否'}；類型：${snapshot.issueType}`,
    `需求描述（完整）：\n${snapshot.description}`, `來源內容版本：${issueDeliveryDigest(snapshot)}`].join('\n');
}

export function deliveryCommitMessage(record: CodexTaskRecord): string {
  const suffix = record.spec.origin?.kind === 'issue' ? ` (#${record.spec.origin.iid})` : '';
  const title = record.spec.title.replace(/[\r\n\0]/g, ' ').replace(/\s+$/, '');
  const subject = suffix ? title.replaceAll(suffix.trim(), '').trimEnd().slice(0, 200 - suffix.length) + suffix : title.slice(0, 200);
  return `${subject}\n\nGitLab-Workspace-Task: ${record.id}`;
}

/** A confirmation binds file bytes and the complete reviewed commit history, not just the final tree. */
export async function deliveryConfirmationDigest(record: CodexTaskRecord, payload?: { headSha?: string; report?: string; targetSha?: string; issueDigest?: string; freshReview?: boolean }): Promise<string> {
  const result = record.result, origin = record.spec.origin;
  if (!result || !origin) throw new Error('尚無綁定來源的可確認成果。');
  let artifact: unknown;
  if (origin.kind === 'issue' || record.spec.source.kind === 'merge-request' && record.spec.source.intent === 'fix-comments') {
    const root = await verifyManagedExecutionRepository(record.spec);
    const head = payload?.headSha ?? (await workflowGit(root, ['rev-parse', 'HEAD'])).trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error('待交付提交版本無效。');
    let reviewedHead = head;
    // A retry may follow the Host's own receipted final commit. Only that exact commit
    // is accounted for by the original confirmation; arbitrary rewrites invalidate it.
    const committed = record.delivery?.steps.find(step => step.kind === 'commit' && step.state === 'confirmed' && step.sha === head);
    if (!payload?.freshReview && committed && record.delivery?.confirmation?.headSha && committed.parentSha === record.delivery.confirmation.headSha &&
      (await workflowGit(root, ['rev-parse', head + '^{tree}'])).trim() === committed.treeSha &&
      (await workflowGit(root, ['log', '-1', '--format=%B', head])).trim() === deliveryCommitMessage(record)) reviewedHead = record.delivery.confirmation.headSha;
    artifact = { content: await implementationDigest(record.spec, result.files ?? []), commits: await implementationCommits(record.spec, reviewedHead),
      head: reviewedHead, plannedCommitMessage: deliveryCommitMessage(record), summary: result.summary, replies: result.replyDrafts,
      validation: record.validation, ...(origin.kind === 'issue' ? { targetSha: payload?.targetSha ?? record.delivery?.confirmation?.targetSha,
        issueDigest: payload?.issueDigest ?? record.delivery?.confirmation?.issueDigest } : {}) };
  } else if (origin.kind === 'project-wiki') artifact = { draftId: result.draftId, revision: result.revision };
  else artifact = { report: result.reportPath ? hash(payload?.report ?? await readWorkflowReport(record.spec, result.reportPath)) : undefined, summary: result.summary };
  return hash(JSON.stringify([record.id, origin, artifact]));
}

/** Call only after this exact preview has been accepted by a human in the owning task window. */
export async function confirmCodexDelivery(record: CodexTaskRecord, expectedDigest?: string, targetSha?: string, issueDigest?: string): Promise<void> {
  if (record.spec.origin?.kind === 'issue' && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(targetSha ?? '')) throw new Error('請先重新預覽並確認目前 GitLab 目標分支版本。');
  if (record.spec.origin?.kind === 'issue' && !/^[a-f0-9]{64}$/.test(issueDigest ?? '')) throw new Error('請先重新預覽並確認目前來源 Issue 的完整內容。');
  const digest = await deliveryConfirmationDigest(record, { targetSha, issueDigest, freshReview: true });
  if (expectedDigest !== undefined && expectedDigest !== digest) throw new Error('成果或提交已在預覽後變更，請重新檢閱再確認。');
  const headSha = record.spec.workflow?.worktree || record.spec.workflow?.managedClone
    ? (await workflowGit(await verifyManagedExecutionRepository(record.spec), ['rev-parse', 'HEAD'])).trim() : undefined;
  record.delivery ??= { mode: 'automatic', state: 'pending', steps: [] };
  record.delivery.mode = 'automatic'; record.delivery.confirmation = { digest, confirmedAt: new Date().toISOString(), headSha,
    ...(record.spec.origin?.kind === 'issue' ? { targetSha, issueDigest } : {}) };
}

/** Host-owned postprocessing. The caller owns task/workspace admission for this entire call. */
export class CodexDeliveryService {
  constructor(private readonly options: CodexDeliveryOptions) {}

  /** Fresh metadata only; no commit, checkpoint, push or GitLab write. */
  async previewTarget(record: CodexTaskRecord, check: () => void): Promise<CodexDeliveryTargetPreview | undefined> {
    const origin = record.spec.origin;
    if (origin?.kind !== 'issue') return undefined;
    const client = await this.options.client(); check();
    if (client.baseUrl !== origin.baseUrl.replace(/\/$/, '')) throw new Error('交付帳號的 GitLab 伺服器已變更。');
    const issue = issueDeliverySnapshot(await client.getIssue(origin.projectId, origin.iid!)); check();
    if (issue.projectId !== origin.projectId || issue.iid !== origin.iid) throw new Error('來源 Issue 的身分已變更。');
    if (issue.state !== 'opened') throw new Error('來源 Issue 已關閉，請先核對需求與交付範圍。');
    const target = await client.getRepositoryBranch(origin.projectId, origin.sourceBranch); check();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target.commit.id)) throw new Error('無法核對 Issue 目標分支版本。');
    return { branch: origin.sourceBranch, baselineSha: origin.sourceSha, sha: target.commit.id,
      compareUrl: `${origin.webUrl.split('/-/')[0]}/-/compare/${origin.sourceSha}...${target.commit.id}`, advanced: target.commit.id !== origin.sourceSha,
      issue, issueDigest: issueDeliveryDigest(issue) };
  }

  private async assertConfirmation(record: CodexTaskRecord, state: CodexDeliveryState, payload?: { headSha?: string; report?: string }): Promise<void> {
    if (!state.confirmation || state.confirmation.digest !== await deliveryConfirmationDigest(record) ||
      payload && state.confirmation.digest !== await deliveryConfirmationDigest(record, payload)) throw new Error('成果或提交已在交付期間變更，請重新檢閱並確認；尚未執行此遠端寫入。');
  }

  private completedIssueWrites(record: CodexTaskRecord, state: CodexDeliveryState): boolean {
    if (record.spec.origin?.kind !== 'issue' || state.steps.some(step => step.state !== 'confirmed')) return false;
    const confirmed = (id: string, kind: CodexDeliveryStep['kind']) => state.steps.find(step => step.id === id && step.kind === kind && step.state === 'confirmed');
    if (record.validation?.noChanges) return !!confirmed('no-changes', 'issue-note')?.resourceId;
    const commit = confirmed('commit', 'commit'), push = confirmed('push', 'push'), mr = confirmed('draft-mr', 'merge-request'), note = confirmed('issue-summary', 'issue-note');
    return !!state.deliveredCommitSha && commit?.sha === state.deliveredCommitSha && push?.sha === state.deliveredCommitSha && !!mr?.resourceId && !!mr.url && !!note?.resourceId;
  }

  /** Run after the durable sending checkpoint and before entering the write call. */
  private async assertWriteReady(record: CodexTaskRecord, state: CodexDeliveryState, step: CodexDeliveryStep, client: GitLabClient,
    save: () => Promise<void>, check: () => void, delivered?: string, report?: string): Promise<void> {
    try {
      await this.assertCurrent(record, client, delivered, check);
      await this.assertConfirmation(record, state, { ...(state.deliveredCommitSha ? { headSha: state.deliveredCommitSha } : {}), ...(report !== undefined ? { report } : {}) }); check();
    } catch (error) {
      // The write has not been invoked. Keep a proven no-effect guard failure
      // retryable; a failure after entering the write still uses reconciliation.
      step.state = 'prepared'; step.error = failure(error); await save(); throw error;
    }
  }

  /** Recover only existing side effects. This method never commits, pushes or POSTs. */
  async reconcile(record: CodexTaskRecord, onCheckpoint: (delivery: CodexDeliveryState) => Promise<void>, check: () => void): Promise<void> {
    if (!record.delivery || !record.spec.origin) return;
    const state = structuredClone(record.delivery), origin = record.spec.origin;
    const client = await this.options.client(); check();
    if (client.baseUrl !== origin.baseUrl.replace(/\/$/, '')) throw new Error('交付帳號的 GitLab 伺服器已變更。');
    for (const step of state.steps.filter(row => row.state === 'sending' || row.state === 'uncertain')) {
      try {
        check();
        if (step.kind === 'commit' && (record.spec.workflow?.worktree || record.spec.workflow?.managedClone)) {
          const root = await verifyManagedExecutionRepository(record.spec);
          const [sha, tree, parent, message] = await Promise.all([
            workflowGit(root, ['rev-parse', 'HEAD']), workflowGit(root, ['rev-parse', 'HEAD^{tree}']),
            workflowGit(root, ['rev-parse', 'HEAD^']).catch(() => ''), workflowGit(root, ['log', '-1', '--format=%B'])
          ]); check();
          if (parent.trim() === step.parentSha && message.includes(`GitLab-Workspace-Task: ${record.id}`)) {
            step.sha = sha.trim(); step.state = 'confirmed'; state.deliveredCommitSha = step.sha;
            if (tree.trim() !== step.treeSha) { state.state = 'needs-attention'; state.error = 'Git hook 變更了已提交成果；請重新驗證，尚未推送。'; }
          } else if (sha.trim() === step.parentSha && step.treeSha && !(await workflowGit(root, ['diff', '--cached', '--name-only', '-z', step.treeSha])).length) {
            // With the owned process stopped, unchanged parent/tree proves no commit was applied.
            step.state = 'prepared';
          }
        } else if (step.kind === 'push' && step.sha) {
          const root = await verifyManagedExecutionRepository(record.spec), remote = await this.pushTarget(record, client, root, check);
          const branch = origin.kind === 'issue' ? origin.branch : origin.sourceBranch;
          if (!branch) throw new Error('缺少 Git 推送分支。');
          await workflowGit(root, ['check-ref-format', `refs/heads/${branch}`]);
          const env = await this.options.networkEnvironment?.(record); check();
          const response = await captureGitProcess('git', ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`], {
            cwd: root, network: true, timeoutMs: 90_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, maxStdoutBytes: 64_000 }); check();
          if (response.code === 0 && response.stdout.trim().split(/\s+/)[0] === step.sha) step.state = 'confirmed';
        } else if (step.kind === 'merge-request') {
          const rows = await client.findMergeRequestsBySourceBranch(origin.projectId, origin.branch!); check();
          const found = rows.find(row => row.source_branch === origin.branch && row.target_branch === origin.sourceBranch && row.description?.includes(marker(step.key)));
          if (found) { step.state = 'confirmed'; step.resourceId = found.iid; step.url = found.web_url; }
        } else if (['issue-note', 'review-note', 'reply'].includes(step.kind)) {
          const rows = origin.kind === 'issue' ? await client.listIssueDiscussions(origin.projectId, origin.iid!) : await client.listMergeRequestDiscussions(origin.projectId, origin.iid!); check();
          const found = findNote(rows, step.key);
          if (found !== undefined) { step.state = 'confirmed'; step.resourceId = found; }
        } else if (step.kind === 'wiki' && this.options.reconcileWiki) {
          const result = await this.options.reconcileWiki(record, check); check();
          if (result?.state === 'published') { step.state = 'confirmed'; step.url = result.url; }
        }
        // GitLab offers no portable content lookup for an unknown upload response.
        if (step.state === 'confirmed' || step.state === 'prepared') step.error = undefined;
      } catch (error) { step.error = failure(error); }
      record.delivery = structuredClone(state); await onCheckpoint(structuredClone(state));
    }
  }

  async deliver(record: CodexTaskRecord, onCheckpoint: (delivery: CodexDeliveryState) => Promise<void>, check: () => void): Promise<CodexTaskResult> {
    if (!record.result) throw new Error('尚未取得可交付的成果。');
    const mode = record.delivery?.mode ?? record.spec.delivery?.mode ?? 'manual';
    if (mode === 'manual') return record.result;
    const state: CodexDeliveryState = structuredClone(record.delivery ?? { mode, state: 'pending', steps: [] });
    const save = async () => { record.delivery = structuredClone(state); await onCheckpoint(structuredClone(state)); };
    if (state.state === 'published') return { ...record.result, state: 'published', url: state.url ?? record.result.url };
    if (state.state === 'cancelled') throw new Error('此任務的自動交付已停止。');
    const origin = record.spec.origin;
    if (!origin) throw new Error('此任務沒有綁定 GitLab 交付目標。');
    if (!state.confirmation || !Number.isFinite(Date.parse(state.confirmation.confirmedAt)) ||
      origin.kind === 'issue' && !this.completedIssueWrites(record, state) && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(state.confirmation.targetSha ?? '') ||
      origin.kind === 'issue' && !this.completedIssueWrites(record, state) && !/^[a-f0-9]{64}$/.test(state.confirmation.issueDigest ?? '') ||
      state.confirmation.digest !== await deliveryConfirmationDigest(record)) {
      state.state = 'needs-attention'; state.error = '請先由人工確認目前成果與提交清單；舊交付偏好不授權發布。'; await save(); return record.result;
    }
    const client = await this.options.client(); check();
    if (client.baseUrl !== origin.baseUrl.replace(/\/$/, '')) throw new Error('交付帳號的 GitLab 伺服器已變更。');
    state.state = 'running'; state.error = undefined; await save();
    try {
      let result: CodexTaskResult;
      if (origin.kind === 'project-wiki') {
        if (!this.options.publishWiki) throw new Error('Wiki 發布服務尚未準備完成。');
        const step = this.step(state, record, 'wiki', 'wiki');
        if (step.state === 'confirmed') result = { ...record.result, state: 'published', url: step.url };
        else {
          // The Wiki store reconciles every page by hash before attempting a write.
          step.state = 'sending'; await save(); check();
          result = await this.options.publishWiki(record, check);
          step.state = result.state === 'published' ? 'confirmed' : result.state === 'uncertain' ? 'uncertain' : 'prepared';
          step.url = result.url; await save();
          if (result.state !== 'published') throw new Error(result.summary);
        }
      } else if (origin.kind === 'issue' || record.spec.source.kind === 'merge-request' && record.spec.source.intent === 'fix-comments') {
        result = await this.implementation(record, state, client, save, check);
      } else {
        if (record.result.state !== 'ready' || !record.result.reportPath) throw new Error('審查報告尚未通過完整性核對。');
        await this.assertCurrent(record, client, undefined, check);
        const report = await readWorkflowReport(record.spec, record.result.reportPath); check();
        await this.assertConfirmation(record, state, { report }); check();
        const digest = hash(report);
        if (state.artifactDigest && state.artifactDigest !== digest) throw new Error('待發布報告內容已變更。');
        state.artifactDigest = digest; await save();
        let body = deliveryComment(report);
        if (body.length > 48_000) {
          const upload = this.step(state, record, 'upload', 'report-upload', digest);
          if (upload.state === 'sending' || upload.state === 'uncertain') throw new Error('先前附件上傳結果待核對；不會重複上傳。');
          if (upload.state !== 'confirmed') {
            await this.assertConfirmation(record, state, { report }); check();
            upload.state = 'sending'; await save(); check();
            try {
              const written = await client.uploadProjectFile(origin.projectId, `review-${record.id}.md`, Buffer.from(report), 'text/markdown');
              upload.url = written.markdown; upload.state = 'confirmed'; await save();
            } catch (error) { upload.state = gitLabWriteFailureEffect(error) === 'none' ? 'prepared' : 'uncertain'; upload.error = failure(error); await save(); throw error; }
          }
          body = `${deliveryComment(record.result.summary)}\n\n完整審查報告：${upload.url}`;
        }
        await this.assertCurrent(record, client, undefined, check);
        await this.note(record, state, client, 'review-note', 'review', body, undefined, save, check, undefined, report);
        result = { ...record.result, state: 'published', url: origin.webUrl };
      }
      check(); state.state = 'published'; state.url = result.url; state.error = undefined; await save(); return result;
    } catch (error) {
      state.state = 'needs-attention'; state.error = failure(error); await save();
      // Preserve a successful model result; a failed publisher must not dispatch a model again.
      return record.result;
    }
  }

  private step(state: CodexDeliveryState, record: CodexTaskRecord, kind: CodexDeliveryStep['kind'], id: string, bodyHash?: string): CodexDeliveryStep {
    const key = hash([record.id, kind, id, bodyHash ?? ''].join('\0'));
    const previous = state.steps.find(step => step.id === id);
    if (previous) {
      if (previous.kind !== kind || previous.key !== key) throw new Error('先前交付步驟的身分或內容已變更。');
      return previous;
    }
    const step: CodexDeliveryStep = { id, kind, key, bodyHash, state: 'prepared' }; state.steps.push(step); return step;
  }

  private async assertCurrent(record: CodexTaskRecord, client: GitLabClient, delivered: string | undefined, check: () => void): Promise<string> {
    const origin = record.spec.origin!; check();
    if (origin.kind === 'issue') {
      const issue = issueDeliverySnapshot(await client.getIssue(origin.projectId, origin.iid!)); check();
      if (issue.state !== 'opened') throw new Error('來源 Issue 已關閉，請先核對需求與交付範圍。');
      if (issue.projectId !== origin.projectId || issue.iid !== origin.iid || issueDeliveryDigest(issue) !== record.delivery?.confirmation?.issueDigest) throw new Error('來源 Issue 內容已在預覽後變更，請重新檢閱並確認交付內容。');
      const target = await client.getRepositoryBranch(origin.projectId, origin.sourceBranch); check();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.commit.id)) throw new Error('無法核對 Issue 目標分支版本。');
      if (target.commit.id !== record.delivery?.confirmation?.targetSha) throw new Error('GitLab 目標分支已在預覽後變更，請重新檢閱差異並確認；尚未執行此遠端寫入。');
      // Preserve the tested base. Only the exact fresh target shown to the human
      // is authorized; another advance requires a new preview, never a rebase.
      return target.commit.id;
    }
    const mr = await client.getMergeRequest(origin.projectId, origin.iid!); check();
    const target = await client.getRepositoryBranch(origin.projectId, origin.targetBranch!); check();
    if (mr.state !== 'opened' || mr.source_branch !== origin.sourceBranch || mr.target_branch !== origin.targetBranch ||
      (mr.diff_refs?.head_sha ?? mr.sha) !== (delivered ?? origin.sourceSha) || target.commit.id !== origin.targetSha ||
      (mr.source_project_id ?? origin.projectId) !== (origin.sourceProjectId ?? origin.projectId)) throw new Error('MR 的來源、目標或版本已變更，請先核對成果。');
    if (record.spec.workflow?.discussions) {
      const rows = await client.listMergeRequestDiscussions(origin.projectId, origin.iid!); check();
      for (const captured of record.spec.workflow.discussions) {
        const current = rows.find(row => row.id === captured.id);
        if (!current) throw new Error('所選 MR 討論已移除。');
        // Ignore this publisher's own receipts when checking the captured human discussion.
        const notes = current.notes.filter(note => !note.system && !note.body.includes('<!-- gitlab-workspace:delivery:'));
        const text = notes.map(note => `#${note.id} ${note.author.name}：\n${note.body}`).join('\n\n');
        if (text !== captured.text || notes.some(note => !captured.noteIds.includes(note.id))) throw new Error('所選 MR 討論已變更，請先核對修正成果。');
      }
    }
    return target.commit.id;
  }

  private async implementation(record: CodexTaskRecord, state: CodexDeliveryState, client: GitLabClient, save: () => Promise<void>, check: () => void): Promise<CodexTaskResult> {
    const origin = record.spec.origin!, result = record.result!;
    if (!record.spec.workflow?.worktree && !record.spec.workflow?.managedClone) throw new Error('交付只支援此任務的隔離 Repo。');
    const cwd = await verifyManagedExecutionRepository(record.spec); check();
    const digest = await implementationDigest(record.spec, result.files ?? []); check();
    const evidence = record.validation;
    if (!evidence || !sameWorkflowPath(evidence.cwd, cwd) || evidence.artifactDigest !== digest ||
      !Number.isFinite(Date.parse(evidence.testedAt)) || !evidence.commands.length || evidence.commands.some(command => command.exitCode !== 0 || command.cwd && !sameWorkflowPath(command.cwd, cwd)) ||
      !evidence.noChanges && result.state !== 'ready') throw new Error('最終修改尚無相同工作目錄與成果版本的成功測試證據。');
    if (state.artifactDigest && state.artifactDigest !== digest) throw new Error('成果已在交付途中變更；請重新測試。');
    state.artifactDigest = digest; await save();
    const mrFix = origin.kind === 'merge-request';
    if (mrFix && !record.spec.workflow.discussions?.length) throw new Error('缺少原任務選取的 MR 討論。');
    // Completed receipts may be recovered and sealed after the target advances.
    // Every possible new write below still performs its own fresh target check.
    if (!this.completedIssueWrites(record, state)) await this.assertCurrent(record, client, state.steps.find(step => step.kind === 'push' && step.state === 'confirmed')?.sha, check);
    if (evidence.noChanges) {
      if ((result.files ?? []).length) throw new Error('無變更成果仍包含待交付檔案，請重新核對。');
      if (mrFix) for (const discussion of record.spec.workflow.discussions!) {
        await this.note(record, state, client, 'reply', 'no-changes-' + discussion.id, deliveryComment(result.summary), discussion.id, save, check);
      }
      else await this.note(record, state, client, 'issue-note', 'no-changes', deliveryComment(result.summary), undefined, save, check);
      return { ...result, state: 'published', url: origin.webUrl };
    }
    const remote = await this.pushTarget(record, client, cwd, check);
    const env = await this.options.networkEnvironment?.(record); check();
    const git = async (args: string[], network = false): Promise<string> => {
      check(); const response = await captureGitProcess('git', args, { cwd, network, timeoutMs: network ? 90_000 : 60_000,
        env: { ...(network ? env ?? process.env : process.env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxStdoutBytes: 8 * 1024 * 1024 });
      check(); if (response.code !== 0) throw new Error(`Git ${args[0]} 未完成（exit ${response.code}），請核對 Git 設定與交付狀態。`); return response.stdout;
    };
    await implementationCommits(record.spec); check();
    const commit = this.step(state, record, 'commit', 'commit', digest);
    if (commit.state !== 'confirmed' && !commit.parentSha && !(await git(['status', '--porcelain', '--untracked-files=normal'])).trim()) {
      const head = (await git(['rev-parse', 'HEAD'])).trim();
      if (head === origin.sourceSha) throw new Error('目前沒有可交付的任務提交。');
      commit.sha = head; commit.treeSha = (await git(['rev-parse', 'HEAD^{tree}'])).trim();
      commit.state = 'confirmed'; state.deliveredCommitSha = head; await save();
    }
    const reconcileCommit = async (): Promise<boolean> => {
      const head = (await git(['rev-parse', 'HEAD'])).trim();
      const tree = (await git(['rev-parse', 'HEAD^{tree}'])).trim();
      const parent = (await git(['rev-parse', 'HEAD^']).catch(() => '')).trim();
      const message = await git(['log', '-1', '--format=%B']);
      if (tree === commit.treeSha && parent === commit.parentSha && message.includes(`GitLab-Workspace-Task: ${record.id}`)) {
        commit.sha = head; commit.state = 'confirmed'; state.deliveredCommitSha = head; await save(); return true;
      }
      return false;
    };
    if (commit.state !== 'confirmed' && !await reconcileCommit()) {
      const head = (await git(['rev-parse', 'HEAD'])).trim();
      if (commit.parentSha && commit.parentSha !== head) throw new Error('Git 提交結果待核對，分支已出現其他提交。');
      const inventory = (await git(['diff', '--no-renames', '--name-only', '-z', origin.sourceSha]) + await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      const files = [...new Set(inventory)].sort();
      if (!files.length || JSON.stringify(files) !== JSON.stringify([...(result.files ?? [])].sort())) throw new Error('待提交檔案與已驗證成果不相同。');
      // The isolated worktree and complete inventory are already verified. Do
      // not pass thousands of path arguments through Windows' command line.
      await git(['add', '--all']);
      const staged = (await git(['diff', '--cached', '--no-renames', '--name-only', '-z', origin.sourceSha])).split('\0').filter(Boolean).sort();
      if (JSON.stringify(staged) !== JSON.stringify(files)) throw new Error('Git index 與已驗證成果不相同。');
      const tree = (await git(['write-tree'])).trim();
      if (commit.treeSha && commit.treeSha !== tree) throw new Error('先前準備的 Git tree 已變更。');
      commit.parentSha = head; commit.treeSha = tree; commit.state = 'sending'; await save();
      try { await git(['commit', '-m', deliveryCommitMessage(record)]); }
      catch (error) { if (!await reconcileCommit()) { commit.state = 'uncertain'; commit.error = failure(error); await save(); throw error; } }
      if (!await reconcileCommit()) throw new Error('Git hook 或其他程序變更了提交內容；尚未推送，請重新測試。');
    }
    const delivered = commit.sha!;
    const deliveredCommits = await implementationCommits(record.spec); check();
    if (!deliveredCommits.length) throw new Error('缺少可驗證的任務提交。');
    if ((await git(['rev-parse', 'HEAD'])).trim() !== delivered || await implementationDigest(record.spec, result.files ?? []) !== digest ||
      (await git(['status', '--porcelain', '--untracked-files=normal'])).trim()) throw new Error('提交後成果已變更，請重新測試；尚未推送。');
    state.deliveredCommitSha = delivered; await save();
    const targetBranch = mrFix ? origin.sourceBranch : origin.branch!;
    await git(['check-ref-format', `refs/heads/${targetBranch}`]);
    const push = this.step(state, record, 'push', 'push', delivered); push.sha = delivered;
    const remoteHead = async (): Promise<string | undefined> => {
      check(); const response = await captureGitProcess('git', ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${targetBranch}`], {
        cwd, network: true, timeoutMs: 90_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, maxStdoutBytes: 64_000 }); check();
      if (response.code === 2) return undefined;
      if (response.code !== 0) throw new Error('無法核對 Git 遠端分支。');
      const value = response.stdout.trim().split(/\s+/)[0]; if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new Error('Git 遠端分支回應無效。'); return value;
    };
    const observed = await remoteHead();
    if (observed !== delivered) {
      if (push.state === 'confirmed' || push.state === 'sending' || push.state === 'uncertain') throw new Error('先前推送結果或目前遠端分支待核對，不會重送。');
      if (observed !== (mrFix ? origin.sourceSha : undefined)) throw new Error('遠端分支已變更，不會覆寫或 Force Push。');
      await this.assertCurrent(record, client, undefined, check);
      push.state = 'sending'; await save();
      await this.assertWriteReady(record, state, push, client, save, check);
      try { await git(['push', remote, `${delivered}:refs/heads/${targetBranch}`], true); }
      catch (error) { if (await remoteHead().catch(() => undefined) !== delivered) { push.state = 'uncertain'; push.error = failure(error); await save(); throw error; } }
      if (await remoteHead() !== delivered) { push.state = 'uncertain'; await save(); throw new Error('推送回應後遠端版本待核對。'); }
    }
    push.state = 'confirmed'; await save();
    if (mrFix) {
      await this.assertCurrent(record, client, delivered, check);
      const drafts = result.replyDrafts ?? [];
      for (const discussion of record.spec.workflow.discussions ?? []) {
        const body = drafts.find(draft => draft.discussionId === discussion.id)?.body ?? result.summary;
        await this.note(record, state, client, 'reply', 'reply-' + discussion.id, `${deliveryComment(body)}\n\n交付提交：${delivered}`, discussion.id, save, check, delivered);
      }
      return { ...result, state: 'published', url: origin.webUrl };
    }
    const mrStep = this.step(state, record, 'merge-request', 'draft-mr', delivered);
    const mrMarker = marker(mrStep.key);
    const find = async (): Promise<GitLabMergeRequest | undefined> => {
      const rows = await client.findMergeRequestsBySourceBranch(origin.projectId, targetBranch); check();
      const same = rows.filter(row => row.source_branch === targetBranch && row.target_branch === origin.sourceBranch &&
        (row.source_project_id ?? origin.projectId) === origin.projectId && (row.target_project_id ?? origin.projectId) === origin.projectId);
      const owned = same.find(row => row.description?.includes(mrMarker));
      if (same.some(row => row !== owned)) throw new Error('此來源分支已有其他 MR，請先人工核對。');
      if (owned && owned.state !== 'opened') throw new Error(`先前建立的 MR 已${owned.state === 'merged' ? '合併' : '關閉'}；不會另建 MR。`);
      return owned;
    };
    let mr = await find();
    if (!mr) {
      if (mrStep.state === 'sending' || mrStep.state === 'uncertain' || mrStep.state === 'confirmed') throw new Error('先前 MR 建立結果待核對，不會重複建立。');
      const observedTarget = await this.assertCurrent(record, client, undefined, check);
      await this.assertConfirmation(record, state, { headSha: delivered }); check();
      mrStep.state = 'sending'; await save();
      await this.assertWriteReady(record, state, mrStep, client, save, check);
      const compare = `${origin.webUrl.split('/-/')[0]}/-/compare/${origin.sourceSha}...${observedTarget}`;
      const baseline = `驗證基準：${origin.sourceSha}\n發布前觀測的目標版本：${observedTarget}` +
        (observedTarget !== origin.sourceSha ? `\n目標分支已前進；本次保留原驗證基準，尚未驗證與新目標整合後的結果。\n[查看基準到目前目標的差異](${compare})` : '');
      const description = deliveryComment(`${result.summary}\n\nRelated to ${origin.webUrl}\n\n${baseline}\n\n測試：\n${record.validation!.commands.map(command => `- ${command.command} · exit ${command.exitCode}`).join('\n')}\n\n交付提交：${delivered}\n\n${mrMarker}`);
      try { mr = await client.createMergeRequest(origin.projectId, { title: `Draft: ${record.spec.title}`.slice(0, 255), sourceBranch: targetBranch, targetBranch: origin.sourceBranch, description }); check(); }
      catch (error) { mr = await find().catch(() => undefined); if (!mr) { mrStep.state = gitLabWriteFailureEffect(error) === 'none' ? 'prepared' : 'uncertain'; mrStep.error = failure(error); await save(); throw error; } }
    }
    mrStep.state = 'confirmed'; mrStep.resourceId = mr.iid; mrStep.url = mr.web_url; await save();
    await this.note(record, state, client, 'issue-note', 'issue-summary', `${deliveryComment(result.summary)}\n\nDraft MR：${mr.web_url}\n交付提交：${delivered}`, undefined, save, check);
    return { ...result, state: 'published', url: mr.web_url };
  }

  private async pushTarget(record: CodexTaskRecord, client: GitLabClient, cwd: string, check: () => void): Promise<string> {
    const origin = record.spec.origin!;
    const sourceProjectId = origin.kind === 'merge-request' ? origin.sourceProjectId ?? origin.projectId : origin.projectId;
    const project = await client.getProject(sourceProjectId); check();
    const remote = origin.sourceRemote ?? record.spec.workflow!.remote;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)) throw new Error('Git 推送目的地無效。');
    const configured = (await workflowGit(cwd, ['remote', 'get-url', '--push', remote])).trim(); check();
    if (origin.sourceRemote || projectRemoteMatches(configured, project)) {
      if (!projectRemoteMatches(configured, project) || origin.pushUrl && origin.pushUrl !== configured) throw new Error('來源 Repo 的推送位置已變更。');
      return remote;
    }
    // A target-project clone may have no remote for the MR's source fork. Use
    // the captured, freshly verified source URL without modifying Git config.
    if (origin.kind === 'merge-request' && origin.pushUrl && projectRemoteMatches(origin.pushUrl, project)) return origin.pushUrl;
    throw new Error('尚未綁定 MR 來源專案的 Git 推送位置。');
  }

  private async note(record: CodexTaskRecord, state: CodexDeliveryState, client: GitLabClient, kind: 'issue-note' | 'review-note' | 'reply', id: string,
    body: string, discussionId: string | undefined, save: () => Promise<void>, check: () => void, delivered?: string, report?: string): Promise<void> {
    const origin = record.spec.origin!;
    if (!body.trim() || body.length > 49_000) throw new Error('待發布留言過長或為空。');
    const step = this.step(state, record, kind, id, hash(body));
    if (step.state === 'confirmed') return;
    const reconcile = async (): Promise<number | undefined> => {
      const rows = origin.kind === 'issue' ? await client.listIssueDiscussions(origin.projectId, origin.iid!) : await client.listMergeRequestDiscussions(origin.projectId, origin.iid!);
      check(); return findNote(discussionId ? rows.filter(row => row.id === discussionId) : rows, step.key);
    };
    const prior = await reconcile();
    if (prior !== undefined) { step.resourceId = prior; step.state = 'confirmed'; await save(); return; }
    if (step.state === 'sending' || step.state === 'uncertain') throw new Error('先前留言送出結果待核對；不會重複送出。');
    await this.assertCurrent(record, client, delivered, check);
    await this.assertConfirmation(record, state, { ...(state.deliveredCommitSha ? { headSha: state.deliveredCommitSha } : {}), ...(report !== undefined ? { report } : {}) }); check();
    step.state = 'sending'; await save(); check();
    await this.assertWriteReady(record, state, step, client, save, check, delivered, report);
    try {
      const marked = `${body.trim()}\n\n${marker(step.key)}`;
      const note = origin.kind === 'issue' ? await client.addIssueNote(origin.projectId, origin.iid!, marked)
        : discussionId ? await client.replyToMergeRequestDiscussion(origin.projectId, origin.iid!, discussionId, marked)
          : await client.createMergeRequestNote(origin.projectId, origin.iid!, marked);
      step.resourceId = note.id; step.state = 'confirmed'; await save();
    } catch (error) {
      const found = await reconcile().catch(() => undefined);
      if (found !== undefined) { step.resourceId = found; step.state = 'confirmed'; await save(); return; }
      step.state = gitLabWriteFailureEffect(error) === 'none' ? 'prepared' : 'uncertain'; step.error = failure(error); await save(); throw error;
    }
  }
}
