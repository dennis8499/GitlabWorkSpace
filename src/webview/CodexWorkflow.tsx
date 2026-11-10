/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { codexTaskActive, type CodexTaskSource, type CodexTaskState } from '../codex/protocol';
import { CommitReviewLaunch } from './CommitReviewLaunch';
import { ActionController, type DispatchResult } from '../workspace/actionController';
import type { CodexUiState } from './codexUiState';
import { useActionSelector } from './useActions';
import { CodexMarkdown } from './CodexMarkdown';
import { codexReplyKey, editCodexReply, settleCodexReplies, wikiLineDiff, type CodexWorkflowUi } from './codexWorkflowUi';
import type { SkillsContext, WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import './codex-panel.css';
import './codex-workflow.css';

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
  const [isolated, setIsolated] = useState(true);
  const label = { issue: '使用 Codex 開發', 'project-wiki': '建立／更新 Wiki', 'merge-request': '一鍵 Code Review' }[source.kind];
  return <section class={`codex-workflow-launch ${compact ? 'compact' : ''}`} aria-label={label}>
    <div class="button-row"><button type="button" class={compact ? 'quiet small' : 'primary'} disabled={disabled}
      onClick={() => post(busy ? { type: 'showCodexTask', taskId: task.id } : { type: 'startCodexTask', source: source.kind === 'issue' ? { ...source, isolated } : source })}>
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

export function CodexWorkflowResult({ task, payload, post, active, actions: sharedActions, ui, onUiChange }: {
  task: CodexTaskState; payload?: WorkflowPayload; post: Post; active: boolean; actions?: ActionController;
  ui?: CodexUiState; onUiChange?: (update: (state: CodexUiState) => CodexUiState) => void;
}) {
  const [selectedPage, setSelectedPage] = useState('');
  const [previewMode, setPreviewMode] = useState<'rendered' | 'source' | 'diff'>('rendered');
  const [changedOnly, setChangedOnly] = useState(false);
  const [localWorkflow, setLocalWorkflow] = useState<CodexWorkflowUi>({ replies: {} });
  const workflow = ui?.workflow ?? localWorkflow, workflowRef = useRef(workflow); workflowRef.current = workflow;
  const fallbackActions = useRef<ActionController>();
  if (!fallbackActions.current) fallbackActions.current = new ActionController(() => {});
  const actions = sharedActions ?? fallbackActions.current;
  const operations = useActionSelector(actions, states => states);
  const restored = useRef(new Set<string>());
  const updateWorkflow = (change: (value: CodexWorkflowUi) => CodexWorkflowUi) => {
    const next = change(workflowRef.current); workflowRef.current = next;
    if (onUiChange) onUiChange(current => ({ ...current, workflow: next })); else setLocalWorkflow(next);
  };
  useEffect(() => {
    const next = settleCodexReplies(workflowRef.current, operations);
    if (next && next !== workflowRef.current) updateWorkflow(() => next);
  }, [operations]);
  useEffect(() => {
    const pending = Object.values(workflowRef.current.replies).filter(item => item.pending && !restored.current.has(item.pending.requestId)).map(item => item.pending!);
    for (const item of pending) { restored.current.add(item.requestId); actions.restorePending(item); }
    if (pending.length) post({ type: 'reconcileOperations', pendingIds: pending.map(item => item.requestId) });
  }, [task.id]);
  useEffect(() => () => fallbackActions.current?.dispose(), []);
  const requested = useRef<string>();
  const result = task.result, wiki = payload?.wiki;
  useEffect(() => {
    if (!active || !result || codexTaskActive(task.status) || task.status === 'queued') return;
    const key = JSON.stringify([task.id, task.turnId, result.draftId, result.reportPath, result.handoffPath]);
    if (requested.current === key) return;
    requested.current = key;
    if (result.draftId) {
      post({ type: 'previewProjectWiki', taskId: task.id });
      return () => { post({ type: 'cancelProjectWikiPreview', taskId: task.id }); };
    }
    else if (result.reportPath || result.handoffPath) post({ type: 'readCodexResult', taskId: task.id });
  }, [active, task.id, task.status, task.turnId, result?.draftId, result?.reportPath, result?.handoffPath]);
  if (!task.origin) return null;
  const busy = codexTaskActive(task.status) || task.status === 'queued' || task.status === 'uncertain';
  const checking = wiki?.progress?.status === 'loading';
  const complete = !wiki?.progress || wiki.progress.status === 'ready';
  const pages = wiki?.pages.filter(item => !changedOnly || item.action !== 'unchanged') ?? [];
  const page = pages.find(item => item.slug === selectedPage) ?? pages[0];
  const openLink = (url: string) => post({ type: 'openExternal', url });
  const openFile = (path: string, line?: number) => post({ type: 'codexCommand', command: { action: 'open-file', taskId: task.id, path, line } });
  const copy = (text: string) => post({ type: 'copy', text });
  return <section class="codex-workflow-result" aria-label="任務來源與成果">
    <div class="button-row">
      {task.origin.kind === 'issue' && result?.state === 'ready' && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'handoff', taskId: task.id } })}>準備交接與 MR 草稿</button>}
      {(task.origin.kind === 'issue' || task.origin.intent === 'fix-comments') && task.isolated && <button type="button" class="quiet small" onClick={() => post({ type: 'codexCommand', command: { action: 'open-worktree', taskId: task.id } })}>開啟實作目錄</button>}
      {task.origin.kind === 'issue' && <button type="button" class="quiet small" onClick={() => post({ type: 'openCodexChanges', taskId: task.id })}>檢視差異</button>}
      {result?.reportPath && task.review && <button type="button" class="quiet small" onClick={() => post({ type: 'openReviewReport', ...task.review! })}>在編輯器開啟報告</button>}
      {result?.url && <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: result.url! })}>在 GitLab 查看 Wiki</button>}</div>
    <p class="subtle codex-root">{task.origin.projectPath} · {task.origin.branch ?? task.origin.sourceBranch} · {task.origin.sourceSha.slice(0, 12)}</p>
    {result && <p role="status">{result.summary}</p>}
    {!!result?.files?.length && <details><summary>修改檔案（{result.files.length}）</summary><ul class="codex-result-files">{result.files.map(file =>
      <li key={file}><button type="button" class="quiet small" onClick={() => post({ type: 'codexCommand', command: { action: 'open-file', taskId: task.id, path: file } })}>{file}</button></li>)}</ul></details>}
    {result?.replyDrafts?.map(reply => {
      const key = codexReplyKey(task.id, reply.discussionId), draft = workflow.replies[key], body = draft?.text ?? reply.body;
      const receipt = Object.values(task.publications ?? {}).find(item => item.kind === 'reply' && item.discussionId === reply.discussionId);
      const pendingOperation = draft?.pending && actions.get(draft.pending.requestId);
      const pending = !!draft?.pending || receipt?.state === 'pending';
      const sent = draft?.confirmedText === body || receipt?.state === 'confirmed' && !draft;
      const unknown = pendingOperation?.effect === 'unknown' || receipt?.state === 'pending' && !['queued', 'running'].includes(pendingOperation?.status ?? '');
      return <details key={key}><summary>討論 {reply.discussionId} 的回覆草稿</summary><label>回覆內容<textarea rows={5} maxLength={50000} value={body}
        onInput={event => { const text = event.currentTarget.value; updateWorkflow(current => editCodexReply(current, task.id, reply.discussionId, text)); }} /></label>
        <button type="button" disabled={busy || !body.trim() || sent || pending} onClick={() => {
          const outcome = post({ type: 'codexCommand', command: { action: 'publish-reply', taskId: task.id, discussionId: reply.discussionId, body } }) as DispatchResult | undefined;
          if (outcome?.status === 'blocked' || !outcome?.operationId) return;
          const operation = actions.get(outcome.operationId); if (!operation) return;
          updateWorkflow(current => {
            const next = current.replies[key] ? current : editCodexReply(current, task.id, reply.discussionId, body), saved = next.replies[key];
            const pending = { requestId: operation.requestId, resourceKey: operation.resourceKey, action: operation.action, label: operation.label,
              scopeRevision: operation.scopeRevision, lockKey: operation.lockKey, text: body, draftRevision: saved.revision };
            return settleCodexReplies({ replies: { ...next.replies, [key]: { ...saved, pending, error: undefined } } }, actions.getSnapshot())!;
          });
        }}>{sent ? '已發布' : pending ? '正在核對發布結果…' : '發布這則回覆'}</button>
        {unknown && <button type="button" class="quiet small" onClick={() => post({ type: 'codexCommand', command: { action: 'reconcile', taskId: task.id } })}>核對這則回覆</button>}
        {(draft?.error || receipt?.error) && <p class="warning" role="alert">{draft?.error ?? receipt?.error}</p>}
        <p class="subtle">{unknown ? '結果尚未確認，草稿已保留；核對完成前不會再次發布。' : '由你確認後發布；每則回覆分別核對 MR 版本與發布收據。'}</p></details>;
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
        <label><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.currentTarget.checked)} />只看有變更或待核對的頁面（{wiki.pages.filter(item => item.action !== 'unchanged').length}）</label>
        <label>預覽頁面<select value={page?.slug ?? ''} onChange={event => setSelectedPage(event.currentTarget.value)}>{pages.map(item =>
          <option key={item.slug} value={item.slug}>{({ unchecked: '待核對', create: '新增', update: '更新', unchanged: '相同' })[item.action]} · {item.slug}</option>)}</select></label>
        <ul class="codex-wiki-pages" aria-label="Wiki 頁面變更">{pages.map(item => <li key={item.slug}><button type="button" class="quiet small" aria-current={item.slug === page?.slug ? 'true' : undefined} onClick={() => setSelectedPage(item.slug)}>
          <span>{({ unchecked: '待核對', create: '新增', update: '更新', unchanged: '相同' })[item.action]}</span> {item.title || item.slug}{item.published ? ' · 已發布' : ''}</button></li>)}</ul>
        <div class="button-row codex-wiki-modes" role="group" aria-label="Wiki 預覽方式">{([['rendered', '閱讀預覽'], ['source', 'Markdown 原文'], ['diff', '檢視變更']] as const).map(([mode, label]) =>
          <button type="button" class="quiet small" aria-pressed={previewMode === mode} onClick={() => setPreviewMode(mode)}>{label}</button>)}</div>
        {!page && <p class="subtle">沒有符合篩選的頁面。</p>}
        {page && <div class="codex-wiki-content" aria-label="Wiki 草稿內容">
          {previewMode === 'rendered' ? <CodexMarkdown text={page.content} onOpenLink={openLink} onOpenFile={openFile} onCopy={copy} /> : previewMode === 'source' ? <pre tabIndex={0}>{page.content}</pre> :
            page.action === 'unchecked' ? <p>這頁尚未核對遠端內容，完成核對後才能檢視變更。</p> : <pre tabIndex={0} class="codex-wiki-diff" aria-label="Wiki 差異">{wikiLineDiff(page.previousContent ?? '', page.content).map((line, index) => <span key={index} class={`codex-diff-${line.kind}`}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}{line.text}{'\n'}</span>)}</pre>}
        </div>}
        <button class="primary" type="button" disabled={busy || checking || !complete || !!wiki.error || !!wiki.uncertain || wiki.pages.every(item => item.published)} onClick={() => post({ type: 'publishProjectWiki', taskId: task.id, revision: wiki.revision })}>發布至 GitLab Wiki</button>
      </>}
    </details>}
    {payload?.report && <details open><summary>完整審查報告</summary><CodexMarkdown text={payload.report} onOpenLink={openLink} onOpenFile={openFile} onCopy={copy} /></details>}
    {payload?.handoff && <details open class="codex-handoff"><summary>交接與 MR 草稿</summary><CodexMarkdown text={payload.handoff} onOpenLink={openLink} onOpenFile={openFile} onCopy={copy} />
      <p class="subtle">先檢閱實際差異，並在版控暫存要提交的變更，再準備 CommitReviewer 檢查。提交、推送及建立 MR 由你操作。</p>
      <div class="button-row"><button type="button" class="quiet small" onClick={() => post({ type: 'copy', text: payload.handoff! })}>複製交接草稿</button>
        <button type="button" disabled={busy} onClick={() => post({ type: 'codexCommand', command: { action: 'handoff-review', taskId: task.id } })}>準備 CommitReviewer 檢查</button></div></details>}
  </section>;
}
