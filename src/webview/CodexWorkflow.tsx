/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { codexTaskActive, type CodexTaskState } from '../codex/protocol';
import { ActionController, type DispatchResult } from '../workspace/actionController';
import type { CodexUiState } from './codexUiState';
import { useActionSelector } from './useActions';
import { CodexMarkdown } from './CodexMarkdown';
import { codexReplyKey, editCodexReply, settleCodexReplies, type CodexWorkflowUi } from './codexWorkflowUi';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import type { ValidationAttempt, WorkContext, WorkLink } from '../codex/workContextProtocol';
import { isDocumentationOnly } from '../codex/documentationVerification';
import './codex-panel.css';
import './codex-workflow.css';

type Post = (request: WorkspaceRequest) => unknown;
export type WorkflowPayload = Extract<WorkspaceResponse, { type: 'codexWorkflowResult' }>;

export function CodexWorkflowResult({ task, payload, post, active, actions: sharedActions, ui, onUiChange }: {
  task: CodexTaskState; payload?: WorkflowPayload; post: Post; active: boolean; actions?: ActionController;
  ui?: CodexUiState; onUiChange?: (update: (state: CodexUiState) => CodexUiState) => void;
}) {
  const [selectedPage, setSelectedPage] = useState('');
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
    if (task.retention === 'results-only') return;
    const pending = Object.values(workflowRef.current.replies).filter(item => item.pending && !restored.current.has(item.pending.requestId)).map(item => item.pending!);
    for (const item of pending) { restored.current.add(item.requestId); actions.restorePending(item); }
    if (pending.length) post({ type: 'reconcileOperations', pendingIds: pending.map(item => item.requestId) });
  }, [task.id, task.retention]);
  useEffect(() => () => fallbackActions.current?.dispose(), []);
  const requested = useRef<string>();
  const result = task.result, wiki = payload?.wiki, linked = !!task.origin;
  useEffect(() => {
    if (!linked || !active || !result || task.retention === 'results-only' || codexTaskActive(task.status) || task.status === 'queued') return;
    const key = JSON.stringify([task.id, task.turnId, result.draftId, result.reportPath, result.handoffPath]);
    if (requested.current === key) return;
    requested.current = key;
    if (result.draftId) {
      post({ type: 'previewProjectWiki', taskId: task.id });
      return () => { post({ type: 'cancelProjectWikiPreview', taskId: task.id }); };
    }
    else if (result.reportPath || result.handoffPath) post({ type: 'readCodexResult', taskId: task.id });
  }, [linked, active, task.id, task.status, task.retention, task.turnId, result?.draftId, result?.reportPath, result?.handoffPath]);
  if (task.savedResult) return <SavedCodexResult task={task} post={post} />;
  if (!task.origin) return result ? <section class="codex-workflow-result" aria-label="本機工作成果"><p role="status">{result.summary}</p>
    <CodexWorkEvidence task={task} post={post} />
    <CodexNextSteps task={task} post={post} />
    <div class="button-row">{task.isolated && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'open-worktree', taskId: task.id } })}>開啟任務視窗</button>}
      {task.groupAnalysis && result.state === 'ready' && <button type="button" disabled={!!task.controls?.external} onClick={() => post({ type: 'codexCommand', command: { action: 'publish-group-issues', taskId: task.id } })}>檢閱並建立 Issue</button>}
      {result.reportPath && <button type="button" onClick={() => post({ type: 'readCodexResult', taskId: task.id })}>開啟需求文件</button>}
      {task.groupAnalysis && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'open-file', taskId: task.id, path: 'issues.json' } })}>檢閱／編輯 Issue 草稿</button>}
      {task.bmadProjectChanges && <button type="button" disabled={!!task.controls?.external} onClick={() => post({ type: 'codexCommand', command: { action: 'apply-project-changes', taskId: task.id } })}>檢閱並套用專案規則</button>}
      <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'copy-handoff', taskId: task.id } })}>複製成果與牌卡內容</button>
      <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'export-result', taskId: task.id } })}>匯出成果包</button></div></section> : null;
  const busy = codexTaskActive(task.status) || task.status === 'queued' || task.status === 'uncertain' || !!task.controls?.external;
  const manualDocumentation = !busy && (task.origin.kind === 'issue' || task.origin.intent === 'fix-comments') &&
    isDocumentationOnly(result?.files ?? []) && !task.workContext?.verification?.commands.length &&
    !(task.validation as { manual?: unknown } | undefined)?.manual && !['running', 'published'].includes(task.delivery?.state ?? '');
  const reviewReport = task.origin.kind === 'merge-request' && (task.origin.intent ?? 'review') === 'review' && task.review &&
    result?.state === 'ready' && payload?.taskId === task.id && payload.report?.trim() ? payload.report : undefined;
  const reviewPublicationBlocked = actions.hasPendingWrite('codex-review:' + task.id) ||
    [task.publication, ...Object.values(task.publications ?? {})].some(receipt => receipt?.kind === 'review' && receipt.state !== 'not-published') ||
    ['unknown', 'pending', 'confirmed'].includes(task.recovery?.publication ?? '');
  const checking = wiki?.progress?.status === 'loading';
  const complete = !wiki?.progress || wiki.progress.status === 'ready';
  const pages = wiki?.pages.filter(item => !changedOnly || item.action !== 'unchanged') ?? [];
  const page = pages.find(item => item.slug === selectedPage) ?? pages[0];
  const openLink = (url: string) => post({ type: 'openExternal', url });
  const openFile = (path: string, line?: number) => post({ type: 'codexCommand', command: { action: 'open-file', taskId: task.id, path, line } });
  const copy = (text: string) => post({ type: 'copy', text });
  return <section class="codex-workflow-result" aria-label="任務來源與成果">
    <div class="button-row">
      {manualDocumentation && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'confirm-documentation', taskId: task.id } })}>人工驗收文件變更</button>}
      {(task.origin.kind === 'issue' || task.origin.intent === 'fix-comments') && result?.state === 'ready' && <button type="button" class="primary" disabled={busy || !!task.controls?.external}
        onClick={() => post({ type: 'codexCommand', command: { action: 'confirm-delivery', taskId: task.id } })}>檢閱並確認交付</button>}
      {task.origin.kind === 'issue' && result?.state === 'ready' && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'handoff', taskId: task.id } })}>準備交接與 MR 草稿</button>}
      {(task.origin.kind === 'issue' || task.origin.intent === 'fix-comments') && task.isolated && <button type="button" class="quiet small" onClick={() => post({ type: 'codexCommand', command: { action: 'open-worktree', taskId: task.id } })}>開啟實作目錄</button>}
      {task.origin.kind === 'issue' && <button type="button" class="quiet small" onClick={() => post({ type: 'openCodexChanges', taskId: task.id })}>檢視差異</button>}
      {result?.reportPath && task.review && <button type="button" class="quiet small" onClick={() => post({ type: 'openReviewReport', ...task.review! })}>在編輯器開啟報告</button>}
      {result?.url && <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: result.url! })}>在 GitLab 查看 Wiki</button>}</div>
    <p class="subtle codex-root">{task.origin.projectPath} · {task.origin.branch ?? task.origin.sourceBranch} · {task.origin.sourceSha.slice(0, 12)}</p>
    {result && <p role="status">{result.summary}</p>}
    <CodexWorkEvidence task={task} post={post} />
    <CodexNextSteps task={task} post={post} />
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
        <ul class="codex-wiki-pages" aria-label="Wiki 頁面變更">{pages.map(item => <li key={item.slug}><button type="button" class="quiet small" aria-current={item.slug === page?.slug ? 'true' : undefined} onClick={() => setSelectedPage(item.slug)}>
          <span>{({ unchecked: '待核對', create: '新增', update: '更新', unchanged: '相同' })[item.action]}</span> {item.title || item.slug}{item.published ? ' · 已發布' : ''}</button></li>)}</ul>
        {page && <div class="button-row codex-wiki-modes" role="group" aria-label="Wiki 文件">
          <button type="button" class="quiet small" onClick={() => post({ type: 'openProjectWikiDocument', taskId: task.id, revision: wiki.revision, slug: page.slug, mode: 'source' })}>在編輯器開啟 Markdown</button>
          <button type="button" class="quiet small" disabled={page.action === 'unchecked'} title={page.action === 'unchecked' ? '先核對遠端頁面，才能比較差異' : undefined} onClick={() => post({ type: 'openProjectWikiDocument', taskId: task.id, revision: wiki.revision, slug: page.slug, mode: 'diff' })}>開啟差異</button></div>}
        {!page && <p class="subtle">沒有符合篩選的頁面。</p>}
        {page && <div class="codex-wiki-content" aria-label="Wiki 草稿內容">
          <CodexMarkdown text={page.content} onOpenLink={openLink} onOpenFile={openFile} onCopy={copy} />
        </div>}
        <button class="primary" type="button" disabled={busy || checking || !complete || !!wiki.error || !!wiki.uncertain || wiki.pages.every(item => item.published)} onClick={() => post({ type: 'publishProjectWiki', taskId: task.id, revision: wiki.revision })}>發布至 GitLab Wiki</button>
      </>}
    </details>}
    {payload?.report && <details open><summary>完整審查報告</summary><CodexMarkdown text={payload.report} onOpenLink={openLink} onOpenFile={openFile} onCopy={copy} />
      {reviewReport && <button type="button" class="primary" disabled={busy || reviewPublicationBlocked}
        onClick={() => post({ type: 'publishCodexReview', taskId: task.id, body: reviewReport })}>發布審查報告留言</button>}</details>}
    {payload?.handoff && <details open class="codex-handoff"><summary>交接與 MR 草稿</summary><CodexMarkdown text={payload.handoff} onOpenLink={openLink} onOpenFile={openFile} onCopy={copy} />
      <p class="subtle">先檢閱實際差異，並在版控暫存要提交的變更，再準備 CommitReviewer 檢查。提交、推送及建立 MR 由你操作。</p>
      <div class="button-row"><button type="button" class="quiet small" onClick={() => post({ type: 'copy', text: payload.handoff! })}>複製交接草稿</button>
        <button type="button" disabled={busy} onClick={() => post({ type: 'codexCommand', command: { action: 'handoff-review', taskId: task.id } })}>準備 CommitReviewer 檢查</button></div></details>}
  </section>;
}

/** Read-only evidence and explicit navigation; rendering never starts the next task. */
export function CodexWorkEvidence({ task, post }: { task: CodexTaskState; post: Post }) {
  const value = task as CodexTaskState & { workContext?: WorkContext; validationAttempts?: ValidationAttempt[]; workLinks?: WorkLink[] };
  const requirement = value.workContext?.requirement, profile = value.workContext?.verification;
  const manual = task.validation?.manual && requirement && task.validation.requirementDigest === requirement.contentDigest ? task.validation.manual : undefined;
  const attempts = value.validationAttempts ?? [], related = (value.workLinks ?? []).filter(link => link.taskId !== task.id);
  const labels: Record<ValidationAttempt['state'], string> = { passed: '通過', failed: '失敗', blocked: '等待處理', interrupted: '已中斷', incomplete: '尚未完成' };
  const kinds: Record<string, string> = { issue: 'Issue 開發', 'group-analysis': '需求探索', 'merge-request': 'MR 工作', 'project-wiki': 'Wiki', review: '審查', skill: '工作流程', bmad: '開發流程', free: '程式工作' };
  if (!requirement && !attempts.length && !related.length) return null;
  return <div class="codex-work-evidence">
    {requirement && <details><summary>本次需求與驗收條件（{requirement.criteria.length}）</summary>
      <p>{requirement.title}</p>
      {requirement.source.url && <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: requirement.source.url! })}>查看來源需求</button>}
      <p class="subtle">這是本次執行採用的來源內容；來源需求更新後，接續前會重新核對。</p>
      {requirement.description && <pre class="codex-source-description">{requirement.description}</pre>}
      {requirement.supplement && <><p>本次補充</p><pre>{requirement.supplement}</pre></>}
      {!!requirement.criteria.length && <><ul>{requirement.criteria.map(criterion => <li key={criterion.id}>{criterion.text} · {manual?.checks.includes(criterion.text) ? '已人工核對' : '尚待逐條核對'}</li>)}</ul>
        <p class="subtle">測試通過不代表每項需求已完成驗收。</p></>}
      {profile && <p>驗證方式：{({ code: '程式檢查', docs: '文件檢查', manual: '人工驗收' })[profile.kind]} · {profile.commands.length} 項命令{profile.manualChecks.length ? ` · ${profile.manualChecks.length} 項人工檢查` : ''}</p>}
      {profile?.manualChecks.map((check, index) => <p key={index}>{manual?.checks.includes(check) ? '已人工核對' : '待人工核對'}：{check}</p>)}
      {manual && <p class="subtle">已完成文件人工驗收；未將人工核對視為自動檢查通過。</p>}
      {profile?.reason && <p>{profile.reason}</p>}
    </details>}
    {!!attempts.length && <details><summary>驗證紀錄（{attempts.length}）</summary>{attempts.map(attempt => <div key={attempt.id}>
      <p>第 {attempt.cycle} 次 · {labels[attempt.state]}</p>
      {attempt.reason && <p class={attempt.state === 'passed' ? 'subtle' : 'warning'}>{attempt.reason}</p>}
      {attempt.commands.map((command, index) => <p key={index}><code>{command.command}</code> · {command.exitCode === undefined ? '尚無執行結果' : `exit ${command.exitCode}`}{command.signal ? ` · ${command.signal}` : ''}</p>)}
    </div>)}</details>}
    {!!related.length && <details><summary>相關工作（{related.length}）</summary><div class="button-row">{related.map(link => <button key={link.taskId} type="button" class="quiet small"
      onClick={() => post({ type: 'showCodexTask', taskId: link.taskId })}>{kinds[link.kind] ?? link.kind} · {link.taskId.slice(0, 8)}</button>)}</div></details>}
  </div>;
}

export function CodexNextSteps({ task, post }: { task: CodexTaskState; post: Post }) {
  const followUps = task.savedResult?.result?.followUps ?? task.result?.followUps ?? [];
  const busy = codexTaskActive(task.status) || task.status === 'queued' || task.status === 'uncertain' || !!task.controls?.external;
  if (!followUps.length) return null;
  return <details class="codex-next-steps"><summary>後續工作（{followUps.length}）</summary>{followUps.map((item, index) => {
    const scoped = typeof item.scope === 'string' && /^[a-f0-9]{64}$/.test(item.scope);
    return <div key={index}>
    <p>{item.title}</p><div class="button-row">
      {item.kind === 'issue' && <>
        <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: item.url })}>在 GitLab 查看 Issue</button>
        {scoped && item.iid !== undefined && <button type="button" disabled={busy} onClick={() => post({ type: 'startCodexTask', source: { kind: 'issue', projectId: item.projectId, issueIid: item.iid!, expectedScope: item.scope! } })}>使用 Codex 開發</button>}
      </>}
      {item.kind === 'merge-request' && <>
        <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: item.url })}>查看 MR</button>
        {scoped && item.iid !== undefined && <>
          <button type="button" disabled={busy} onClick={() => post({ type: 'startCodexTask', source: { kind: 'merge-request', projectId: item.projectId, iid: item.iid!, reviewerTool: 'merge-reviewer', expectedScope: item.scope! } })}>Merge Review</button>
          <button type="button" disabled={busy} onClick={() => post({ type: 'startCodexTask', source: { kind: 'merge-request', projectId: item.projectId, iid: item.iid!, reviewerTool: 'release-reviewer', expectedScope: item.scope! } })}>Release Review</button>
        </>}
      </>}
      {item.kind === 'wiki' && <button type="button" class="quiet small" onClick={() => post({ type: 'openExternal', url: item.url })}>查看 Wiki</button>}
    </div>
    {!scoped && item.kind !== 'wiki' && <p class="subtle">這份歷史成果未保存來源帳號，請從原專案啟動新的工作。</p>}
  </div>;
  })}</details>;
}

function SavedCodexResult({ task, post }: { task: CodexTaskState; post: Post }) {
  const [artifactLimit, setArtifactLimit] = useState(100);
  const artifactList = useRef<HTMLUListElement>(null), nextArtifactFocus = useRef<{ taskId: string; index: number }>();
  useLayoutEffect(() => { nextArtifactFocus.current = undefined; setArtifactLimit(100); }, [task.id]);
  useLayoutEffect(() => {
    const pending = nextArtifactFocus.current; nextArtifactFocus.current = undefined;
    if (pending?.taskId === task.id) artifactList.current?.querySelectorAll('button')[pending.index]?.focus();
  }, [artifactLimit, task.id]);
  const saved = task.savedResult!;
  const delivery = task.delivery ?? saved.delivery;
  const result = saved.result;
  return <section class="codex-workflow-result" aria-label="已保存成果">
    <p role="status">{saved.summary}</p>
    <p class="subtle">成果已獨立保存，可離線閱讀與匯出。後續需求會以成果建立新的任務。</p>
    <CodexNextSteps task={task} post={post} />
    <div class="button-row">
      <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'export-result', taskId: task.id } })}>匯出成果包</button>
      <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'copy-handoff', taskId: task.id } })}>複製接續摘要與牌卡內容</button>
      <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'new-from-result', taskId: task.id } })}>以成果建立新任務</button>
      {saved.restore && <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'restore-result', taskId: task.id } })}>還原至新的手動工作目錄</button>}
      <button type="button" onClick={() => post({ type: 'codexCommand', command: { action: 'manual-handoff', taskId: task.id } })}>轉交人工處理</button>
      {(delivery?.url ?? result?.url) && <button type="button" onClick={() => post({ type: 'openExternal', url: delivery?.url ?? result!.url! })}>開啟 GitLab 成果</button>}
    </div>
    {delivery && 'error' in delivery && delivery.error && <p class="warning" role="status">{delivery.error}</p>}
    {!!saved.artifacts.length && <ul ref={artifactList} class="codex-result-files" aria-label="成果檔案">{saved.artifacts.slice(0, artifactLimit).map(artifact => <li key={artifact.id}>
      <button type="button" class="quiet small" onClick={() => post({ type: 'codexCommand', command: { action: 'open-artifact', taskId: task.id, artifactId: artifact.id } })}>{artifact.name}</button>
      <span class="subtle"> · {artifact.size.toLocaleString()} bytes</span>
    </li>)}</ul>}
    {saved.artifacts.length > artifactLimit && <button type="button" onClick={() => { nextArtifactFocus.current = { taskId: task.id, index: artifactLimit }; setArtifactLimit(limit => Math.min(saved.artifacts.length, limit + 100)); }}>
      顯示更多成果（{artifactLimit}/{saved.artifacts.length}）</button>}
    {!!result?.tests?.length && <details><summary>測試結果（{result.tests.length}）</summary>{result.tests.map((test, index) => <p key={index}><code>{test.command}</code> · exit {test.exitCode}</p>)}</details>}
    {task.validation?.commands.length ? <details><summary>已核對的測試證據（{task.validation.commands.length}）</summary>{task.validation.commands.map((test, index) => <p key={index}><code>{test.command}</code> · exit {test.exitCode}</p>)}</details> : null}
  </section>;
}
