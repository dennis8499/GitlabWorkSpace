/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { codexTaskActive, type CodexTaskSource, type CodexTaskState } from '../codex/protocol';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import './codex-panel.css';

type LinkedSource = Extract<CodexTaskSource, { kind: 'issue' | 'project-wiki' | 'merge-request' }>;
type Post = (request: WorkspaceRequest) => unknown;
export type WorkflowPayload = Extract<WorkspaceResponse, { type: 'codexWorkflowResult' }>;

export function taskForSource(tasks: readonly CodexTaskState[], source: LinkedSource): CodexTaskState | undefined {
  const matches = tasks.filter(task => task.origin?.kind === source.kind && task.origin.projectId === source.projectId &&
    (source.kind === 'issue' ? task.origin.iid === source.issueIid : source.kind === 'merge-request' ? task.origin.iid === source.iid : true));
  return matches.find(task => codexTaskActive(task.status) || task.status === 'queued') ?? matches[0];
}

export function CodexWorkflowLaunch({ tasks, source, post, compact = false, disabled = false }: {
  tasks: readonly CodexTaskState[]; source: LinkedSource; post: Post; compact?: boolean; disabled?: boolean;
}) {
  const task = taskForSource(tasks, source), busy = task && (codexTaskActive(task.status) || task.status === 'queued');
  const label = { issue: '使用 Codex 開發', 'project-wiki': '建立／更新 Wiki', 'merge-request': '一鍵 Code Review' }[source.kind];
  return <section class={`codex-workflow-launch ${compact ? 'compact' : ''}`} aria-label={label}>
    <div class="button-row"><button type="button" class={compact ? 'quiet small' : 'primary'} disabled={disabled}
      onClick={() => post(busy ? { type: 'showCodexTask', taskId: task.id } : { type: 'startCodexTask', source })}>
      {busy ? source.kind === 'issue' ? '查看開發任務' : '查看執行任務' : label}</button>
      {task && !busy && <button type="button" class="quiet small" onClick={() => post({ type: 'showCodexTask', taskId: task.id })}>查看上次成果</button>}
      {source.kind === 'issue' && task?.result?.files?.length ? <button type="button" class="quiet small" onClick={() => post({ type: 'openCodexChanges', taskId: task.id })}>檢視差異</button> : null}
    </div>
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
  const result = task.result, wiki = payload?.wiki;
  useEffect(() => {
    if (!active || !result || codexTaskActive(task.status) || task.status === 'queued') return;
    if (result.draftId) post({ type: 'previewProjectWiki', taskId: task.id });
    else if (result.reportPath) post({ type: 'readCodexResult', taskId: task.id });
  }, [active, task.id, task.status, result?.draftId, result?.revision, result?.reportPath]);
  if (!task.origin) return null;
  const busy = codexTaskActive(task.status) || task.status === 'queued' || task.status === 'uncertain';
  const page = wiki?.pages.find(item => item.slug === selectedPage) ?? wiki?.pages[0];
  return <section class="codex-workflow-result" aria-label="任務來源與成果">
    <div class="button-row">
      {task.origin.kind === 'issue' && <button type="button" class="quiet small" onClick={() => post({ type: 'openCodexChanges', taskId: task.id })}>檢視差異</button>}
      {result?.reportPath && task.review && <button type="button" class="quiet small" onClick={() => post({ type: 'openReviewReport', ...task.review! })}>在編輯器開啟報告</button>}
      {result?.url && <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: result.url! })}>在 GitLab 查看 Wiki</button>}</div>
    <p class="subtle codex-root">{task.origin.projectPath} · {task.origin.branch ?? task.origin.sourceBranch} · {task.origin.sourceSha.slice(0, 12)}</p>
    {result && <p role="status">{result.summary}</p>}
    {!!result?.tests?.length && <details><summary>測試結果（{result.tests.length}）</summary>{result.tests.map((test, index) => <p key={index}><code>{test.command}</code> · exit {test.exitCode}</p>)}</details>}
    {result?.draftId && <details class="codex-wiki-preview" open><summary>Wiki 發布預覽</summary>
      <div class="button-row"><button type="button" class="quiet small" disabled={busy} onClick={() => post({ type: 'previewProjectWiki', taskId: task.id, refresh: true })}>重新預覽／核對結果</button>
        {wiki?.error && <button type="button" class="quiet small" disabled={busy} onClick={() => post({ type: 'previewProjectWiki', taskId: task.id, confirmRetry: true })}>確認後允許重試</button>}</div>
      {!wiki ? <p role="status">正在讀取草稿與遠端頁面，失敗時可重新預覽。</p> : <>
        <p>{wiki.projectPath} · {wiki.sourceBranch} @ {wiki.sourceSha.slice(0, 12)} · {wiki.pages.filter(item => item.published).length}/{wiki.pages.length} 已發布</p>
        {wiki.error && <p class="warning" role="alert">{wiki.error}</p>}
        <label>預覽頁面<select value={page?.slug ?? ''} onChange={event => setSelectedPage(event.currentTarget.value)}>{wiki.pages.map(item =>
          <option key={item.slug} value={item.slug}>{({ create: '新增', update: '更新', unchanged: '相同' })[item.action]} · {item.slug}</option>)}</select></label>
        {page && <><pre tabIndex={0} aria-label="Wiki 草稿內容">{page.content}</pre>
          {page.action === 'update' && <details><summary>目前 GitLab 內容</summary><pre tabIndex={0}>{page.previousContent}</pre></details>}</>}
        <button class="primary" type="button" disabled={busy || !!wiki.error || !!wiki.uncertain || wiki.pages.every(item => item.published)} onClick={() => post({ type: 'publishProjectWiki', taskId: task.id, revision: wiki.revision })}>發布至 GitLab Wiki</button>
      </>}
    </details>}
    {payload?.report && <details><summary>完整審查報告</summary><pre tabIndex={0}>{payload.report}</pre></details>}
  </section>;
}
