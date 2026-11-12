/** @jsxImportSource preact */
import { codexTaskActive, type CodexTaskSource, type CodexTaskState } from '../codex/protocol';
import { CommitReviewLaunch } from './CommitReviewLaunch';
import type { SkillsContext, WorkspaceRequest } from '../workspace/workspaceProtocol';
import './codex-workflow.css';
type LinkedSource = Extract<CodexTaskSource, { kind: 'issue' | 'project-wiki' | 'merge-request' }>;
type Post = (request: WorkspaceRequest) => unknown;

export function taskForSource(tasks: readonly CodexTaskState[], source: LinkedSource): CodexTaskState | undefined {
  const matches = tasks.filter(task => task.origin?.kind === source.kind && task.origin.projectId === source.projectId &&
    (source.kind === 'issue' ? task.origin.iid === source.issueIid : source.kind === 'merge-request' ? task.origin.iid === source.iid && (task.origin.intent ?? 'review') === (source.intent ?? 'review') : true));
  return matches.find(task => codexTaskActive(task.status) || task.status === 'queued') ?? matches[0];
}

export function CodexWorkflowLaunch({ tasks, source, post, compact = false, disabled = false, skillsContext }: {
  tasks: readonly CodexTaskState[]; source: LinkedSource; post: Post; compact?: boolean; disabled?: boolean; skillsContext?: SkillsContext;
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
    {source.kind === 'merge-request' && !busy && <button type="button" class="quiet small" disabled={disabled} onClick={() => post({ type: 'startCodexTask', source: { ...source, intent: 'fix-comments' } })}>將討論轉成修正任務</button>}
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
