/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { codexTaskActive, type CodexTaskSource, type CodexTaskState } from '../codex/protocol';
import { CommitReviewLaunch } from './CommitReviewLaunch';
import type { SkillsContext, WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import './codex-panel.css';

type LinkedSource = Extract<CodexTaskSource, { kind: 'issue' | 'project-wiki' | 'merge-request' }>;
type Post = (request: WorkspaceRequest) => unknown;
export type WorkflowPayload = Extract<WorkspaceResponse, { type: 'codexWorkflowResult' }>;

export function taskForSource(tasks: readonly CodexTaskState[], source: LinkedSource): CodexTaskState | undefined {
  const matches = tasks.filter(task => task.origin?.kind === source.kind && task.origin.projectId === source.projectId &&
    (source.kind === 'issue' ? task.origin.iid === source.issueIid : source.kind === 'merge-request' ? task.origin.iid === source.iid && (task.origin.intent ?? 'review') === (source.intent ?? 'review') : true));
  return matches.find(task => codexTaskActive(task.status) || task.status === 'queued') ?? matches[0];
}

export function CodexWorkflowLaunch({ tasks, source, post, compact = false, disabled = false, skillsContext }: {
  tasks: readonly CodexTaskState[]; source: LinkedSource; post: Post; compact?: boolean; disabled?: boolean; skillsContext?: SkillsContext;
}) {
  const task = taskForSource(tasks, source), busy = task && (codexTaskActive(task.status) || task.status === 'queued');
  const [isolated, setIsolated] = useState(false);
  const label = { issue: '使用 Codex 開發', 'project-wiki': '建立／更新 Wiki', 'merge-request': '一鍵 Code Review' }[source.kind];
  return <section class={`codex-workflow-launch ${compact ? 'compact' : ''}`} aria-label={label}>
    <div class="button-row"><button type="button" class={compact ? 'quiet small' : 'primary'} disabled={disabled}
      onClick={() => post(busy ? { type: 'showCodexTask', taskId: task.id } : { type: 'startCodexTask', source: source.kind === 'issue' && isolated ? { ...source, isolated: true } : source })}>
      {busy ? source.kind === 'issue' ? '查看開發任務' : '查看執行任務' : label}</button>
      {task && !busy && <button type="button" class="quiet small" onClick={() => post({ type: 'showCodexTask', taskId: task.id })}>查看上次成果</button>}
      {source.kind === 'issue' && task?.result?.files?.length ? <button type="button" class="quiet small" onClick={() => post({ type: 'openCodexChanges', taskId: task.id })}>檢視差異</button> : null}
    </div>
    {source.kind === 'merge-request' && !busy && <button type="button" class="quiet small" disabled={disabled} onClick={() => post({ type: 'startCodexTask', source: { ...source, intent: 'fix-comments' } })}>將討論轉成修正任務</button>}
    {source.kind === 'issue' && !busy && <label><input type="checkbox" checked={isolated} disabled={disabled} onChange={event => setIsolated(event.currentTarget.checked)} />在隔離 worktree 執行</label>}
    {source.kind === 'issue' && <CommitReviewLaunch post={post} skills={skillsContext} projectId={source.projectId} issueIid={source.issueIid} disabled={disabled} />}
    {!compact && task?.result && <p class="subtle" role="status">{task.result.summary}</p>}
    {!compact && source.kind === 'issue' && task?.result && (!!task.result.files?.length || !!task.result.tests?.length) &&
      <details><summary>修改與測試結果</summary>
        <p>修改 {task.result.files?.length ?? 0} 個檔案；已核對 {task.result.tests?.length ?? 0} 個測試命令。</p>
        {task.result.tests?.map((test, index) => <p key={index}><code>{test.command}</code> · exit {test.exitCode}</p>)}
      </details>}
    {!compact && source.kind === 'issue' && !task && <p class="subtle">自動建立 Issue 分支，由 BMAD 選擇流程並完成實作與測試，完成後由你檢閱及提交。</p>}
  </section>;
}

export function CodexWorkflowResult({ task, payload, post, active }: {
  task: CodexTaskState; payload?: WorkflowPayload; post: Post; active: boolean;
}) {
  const [selectedPage, setSelectedPage] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sentReplies, setSentReplies] = useState<ReadonlySet<string>>(() => new Set());
  const requested = useRef<string>();
  const result = task.result, wiki = payload?.wiki;
  useEffect(() => {
    if (!active || !result || codexTaskActive(task.status) || task.status === 'queued') return;
    const key = JSON.stringify([task.id, task.turnId, result.draftId, result.reportPath]);
    if (requested.current === key) return;
    requested.current = key;
    if (result.draftId) {
      post({ type: 'previewProjectWiki', taskId: task.id });
      return () => { post({ type: 'cancelProjectWikiPreview', taskId: task.id }); };
    }
    else if (result.reportPath) post({ type: 'readCodexResult', taskId: task.id });
  }, [active, task.id, task.status, task.turnId, result?.draftId, result?.reportPath]);
  if (!task.origin) return null;
  const busy = codexTaskActive(task.status) || task.status === 'queued' || task.status === 'uncertain';
  const checking = wiki?.progress?.status === 'loading';
  const complete = !wiki?.progress || wiki.progress.status === 'ready';
  const page = wiki?.pages.find(item => item.slug === selectedPage) ?? wiki?.pages[0];
  return <section class="codex-workflow-result" aria-label="任務來源與成果">
    <div class="button-row">
      {task.origin.kind === 'issue' && result?.state === 'ready' && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'handoff', taskId: task.id } })}>準備 CommitReviewer 與 MR 草稿</button>}
      {task.origin.kind === 'issue' && <button type="button" class="quiet small" onClick={() => post({ type: 'openCodexChanges', taskId: task.id })}>檢視差異</button>}
      {result?.reportPath && task.review && <button type="button" class="quiet small" onClick={() => post({ type: 'openReviewReport', ...task.review! })}>在編輯器開啟報告</button>}
      {result?.url && <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: result.url! })}>在 GitLab 查看 Wiki</button>}</div>
    <p class="subtle codex-root">{task.origin.projectPath} · {task.origin.branch ?? task.origin.sourceBranch} · {task.origin.sourceSha.slice(0, 12)}</p>
    {result && <p role="status">{result.summary}</p>}
    {result?.replyDrafts?.map(reply => {
      const key = `${task.id}:${reply.discussionId}`, body = replyDrafts[key] ?? reply.body;
      return <details key={key}><summary>討論 {reply.discussionId} 的回覆草稿</summary><label>回覆內容<textarea rows={5} maxLength={50000} value={body}
        onInput={event => {
          setReplyDrafts(current => ({ ...current, [key]: event.currentTarget.value }));
          if (task.publication?.state === 'not-published') setSentReplies(current => new Set([...current].filter(value => value !== key)));
        }} /></label>
        <button type="button" disabled={busy || !body.trim() || sentReplies.has(key) || task.publication?.state === 'pending'} onClick={() => {
          post({ type: 'codexCommand', command: { action: 'publish-reply', taskId: task.id, discussionId: reply.discussionId, body } });
          setSentReplies(current => new Set([...current, key]));
        }}>發布這則回覆</button><p class="subtle">發布前重新核對 MR 版本；送出後請回原 MR 檢查結果，逾時先核對狀態。</p></details>;
    })}
    {!!result?.tests?.length && <details><summary>測試結果（{result.tests.length}）</summary>{result.tests.map((test, index) => <p key={index}><code>{test.command}</code> · exit {test.exitCode}</p>)}</details>}
    {result?.draftId && <details class="codex-wiki-preview" open><summary>Wiki 發布預覽</summary>
      <div class="button-row"><button type="button" class="quiet small" disabled={busy || checking} onClick={() => post({ type: 'previewProjectWiki', taskId: task.id, refresh: true })}>重新預覽／核對結果</button>
        {checking && <button type="button" class="quiet small" onClick={() => post({ type: 'cancelProjectWikiPreview', taskId: task.id })}>停止核對</button>}
        {!checking && !complete && <button type="button" disabled={busy} onClick={() => post({ type: 'previewProjectWiki', taskId: task.id, cursor: wiki?.progress?.nextCursor })}>繼續核對其餘頁面</button>}
        {wiki?.uncertain && <button type="button" class="quiet small" disabled={busy || checking} onClick={() => post({ type: 'previewProjectWiki', taskId: task.id, confirmRetry: true })}>確認後允許重試</button>}</div>
      {!wiki ? <p role="status">正在讀取草稿與遠端頁面，失敗時可重新預覽。</p> : <>
        <p>{wiki.projectPath} · {wiki.sourceBranch} @ {wiki.sourceSha.slice(0, 12)} · {wiki.pages.filter(item => item.published).length}/{wiki.pages.length} 已發布</p>
        {wiki.progress && <p role="status" aria-live="polite">已核對 {wiki.progress.completed}/{wiki.progress.total} 頁{checking ? '，正在核對…' : wiki.progress.reason ? ` · ${wiki.progress.reason}` : ''}</p>}
        {wiki.error && <p class="warning" role="alert">{wiki.error}</p>}
        <label>預覽頁面<select value={page?.slug ?? ''} onChange={event => setSelectedPage(event.currentTarget.value)}>{wiki.pages.map(item =>
          <option key={item.slug} value={item.slug}>{({ unchecked: '待核對', create: '新增', update: '更新', unchanged: '相同' })[item.action]} · {item.slug}</option>)}</select></label>
        {page && <><pre tabIndex={0} aria-label="Wiki 草稿內容">{page.content}</pre>
          {page.action === 'update' && <details><summary>目前 GitLab 內容</summary><pre tabIndex={0}>{page.previousContent}</pre></details>}</>}
        <button class="primary" type="button" disabled={busy || checking || !complete || !!wiki.error || !!wiki.uncertain || wiki.pages.every(item => item.published)} onClick={() => post({ type: 'publishProjectWiki', taskId: task.id, revision: wiki.revision })}>發布至 GitLab Wiki</button>
      </>}
    </details>}
    {payload?.report && <details><summary>完整審查報告</summary><pre tabIndex={0}>{payload.report}</pre></details>}
  </section>;
}
