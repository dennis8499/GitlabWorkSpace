/** @jsxImportSource preact */
import type { CodexTaskState, CodexApprovalSettings } from '../codex/protocol';
import type { WorkspaceRequest } from '../workspace/workspaceProtocol';

const waits = { approval: '等待回覆或核准', resource: '等待其他任務釋放共用資源', capacity: '等待本機執行槽位', quota: '等待額度可用', tool: '等待外部工具', storage: '等待儲存區修復' };
export function CodexTaskDetails({ task, post }: { task: CodexTaskState; post(request: WorkspaceRequest): unknown }) {
  const progress = task.progress, approvals = task.controls?.approvals ?? { command: true, file: true, permissions: true };
  const update = (key: keyof CodexApprovalSettings, value: boolean) => post({ type: 'codexCommand', command: { action: 'approvals', taskId: task.id, settings: { ...approvals, [key]: value } } });
  return <div class="codex-task-details">
    {task.queuePosition !== undefined && <p>排隊位置：{task.queuePosition}</p>}
    {task.publication && <p role="status">MR 發布：{({ pending: '結果待核對', confirmed: '已確認發布', 'not-published': '尚未發布' })[task.publication.state]}</p>}
    {progress?.waitReason && <p role="status">{waits[progress.waitReason]}</p>}
    {progress?.plan?.length ? <details open><summary>執行計畫</summary><ol>{progress.plan.map((step, index) => <li key={index}>
      <span>{({ pending: '待處理', inProgress: '進行中', completed: '已完成' })[step.status]}：</span>{step.step}</li>)}</ol></details> : null}
    <details><summary>模型與使用量{progress?.model ? ` · ${progress.model}` : ''}</summary>
      <p>任務設定：{task.selection?.model ?? '沿用本機設定'}{task.selection?.effort ? ` · ${task.selection.effort}` : ''}</p>
      <p>實際執行：{progress?.model ?? '尚未回報'}{progress?.effort ? ` · ${progress.effort}` : ''}</p>
      <p>Token：{progress?.tokens ? `${progress.tokens.total.toLocaleString()}（輸入 ${progress.tokens.input.toLocaleString()}／輸出 ${progress.tokens.output.toLocaleString()}）` : '未知'}</p>
      <p>額度：{progress?.quota ? `${progress.quota.usedPercent}% 已使用${progress.quota.resetsAt ? ` · ${new Date(progress.quota.resetsAt * 1000).toLocaleString()} 重設` : ''}` : '未知'}</p>
      {progress?.tool && <p>工具：{progress.tool}</p>}{progress?.updatedAt && <p class="subtle">最後更新：{new Date(progress.updatedAt).toLocaleString()}</p>}
    </details>
    <details><summary>自動核准範圍</summary><div class="codex-approval-options">{(['command', 'file', 'permissions'] as const).map(key => <label key={key}>
      <input type="checkbox" checked={approvals[key]} disabled={!task.controls?.canAutoAccept} onChange={event => update(key, event.currentTarget.checked)} />
      {({ command: '命令', file: '檔案修改', permissions: '額外權限' })[key]}</label>)}</div><p class="subtle">只在本次任務的 Auto-Accept 開啟時套用；問題與表單仍需回答。</p></details>
    {task.recovery && <details open><summary>核對結果</summary><p>{task.recovery.message}</p>
      <p>執行：{({ unknown: '待核對', 'not-started': '未開始', running: '仍在執行', completed: '已完成', failed: '失敗', interrupted: '已中斷' })[task.recovery.execution]} ·
        清理：{task.recovery.cleanup === 'confirmed' ? '已確認' : '待核對'} · 發布：{({ unknown: '未知', 'not-published': '未發布', pending: '待對帳', confirmed: '已確認' })[task.recovery.publication]}</p>
      <p class="subtle">{new Date(task.recovery.checkedAt).toLocaleString()}</p></details>}
    {task.goal && <details open><summary>目標模式 · {task.goal.status ?? '待啟用'}</summary><p>{task.goal.objective}</p>
      <p>Token 預算：{task.goal.tokenBudget?.toLocaleString() ?? '未設定'} · 使用：{task.goal.tokensUsed?.toLocaleString() ?? '未知'}{task.goal.timeBudgetSeconds ? ` · 時間預算 ${Math.round(task.goal.timeBudgetSeconds / 60)} 分鐘` : ''}</p></details>}
  </div>;
}
