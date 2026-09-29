/** @jsxImportSource preact */
import type { GitLabIssue, GitLabMember, GitLabProject } from '../api/types';
import type { WorkspaceRequest, WorkspaceSnapshot, WorkspaceTimerEntry, DeliveryPreview } from '../workspace/workspaceProtocol';

export interface DeliveryFormState {
  workId: string;
  summary: string;
  changes: string;
  tests: string;
  targetBranch: string;
  reviewerIds: number[];
  acceptanceConfirmed: boolean;
}

export interface TimeEdit { duration: string; summary: string; spentAt: string; }

export function DeliveryEditor({
  issue, project, root, repo, members, busy, initial, onUpdate, onPrepare, records, onAction, onOpenExternal
}: {
  issue: GitLabIssue; project: GitLabProject; root?: string; repo?: WorkspaceSnapshot['localRepositories'][number]; members: GitLabMember[]; busy: boolean;
  initial?: DeliveryFormState; onUpdate: (patch: Partial<DeliveryFormState>) => void;
  onPrepare: (form: DeliveryFormState) => void; records: DeliveryPreview[];
  onAction: (action: WorkspaceRequest['type'], record: DeliveryPreview) => void; onOpenExternal: (url: string) => void;
}) {
  const form: DeliveryFormState = {
    workId: '', summary: '', changes: '', tests: '', targetBranch: project.default_branch ?? 'main', reviewerIds: [], acceptanceConfirmed: false,
    ...initial
  };
  return <>
    <div class="delivery-grid">
      <label class="field">Megin ?? ID<input placeholder="MEGIN-123-feature-name" value={form.workId} onInput={(event) => onUpdate({ workId: event.currentTarget.value })} /></label>
      <label class="field">Commit 摘要<input placeholder={`[${project.path_with_namespace}#${issue.iid}] 修改摘要`} value={form.summary} onInput={(event) => onUpdate({ summary: event.currentTarget.value })} /></label>
      <label class="field full">修改內容<textarea rows={3} value={form.changes} onInput={(event) => onUpdate({ changes: event.currentTarget.value })} /></label>
      <label class="field full">驗證結果<textarea rows={2} value={form.tests} onInput={(event) => onUpdate({ tests: event.currentTarget.value })} /></label>
      <label class="field">目標分支<input value={form.targetBranch} onInput={(event) => onUpdate({ targetBranch: event.currentTarget.value })} /></label>
      <div class="field reviewer-picks"><span>MR 審查者</span><div>{members.slice(0, 50).map((member) => <label class="check-inline"><input type="checkbox" checked={form.reviewerIds.includes(member.id)} onChange={(event) => onUpdate({ reviewerIds: event.currentTarget.checked ? [...new Set([...form.reviewerIds, member.id])] : form.reviewerIds.filter((id) => id !== member.id) })} />{member.name}</label>)}</div></div>
      <p class="subtle field-hint">Repo：{repo?.path ?? '尚未 Clone'}{root ? `　·　Worktree：${repo?.state ?? '未知'}` : ''}</p>
      <label class="check-inline field-hint"><input type="checkbox" checked={form.acceptanceConfirmed} onChange={(event) => onUpdate({ acceptanceConfirmed: event.currentTarget.checked })} />我已使用 Megin 完成人工驗收，現在的差異就是已驗收內容</label>
    </div>
    <button class="primary" type="button" disabled={busy || repo?.state !== 'ready' || !form.workId || !form.summary || !form.changes || !form.tests || !form.acceptanceConfirmed} onClick={() => onPrepare(form)}>檢查交付並預覽差異</button>
    {records.map((record) => <div class="delivery-record"><div class="panel-title"><div><strong>{record.workId}</strong><span class="subtle">　{record.branch} → {record.targetBranch}</span></div><span class={`pill ${record.gate.ok ? 'success' : 'danger'}`}>{record.gate.ok ? '驗收快照有效' : '驗收未通過'}</span></div>
      <p><strong>Commit：</strong>{record.summary}　<strong>狀態：</strong>{({ preview: '待檢查差異', committed: '已 Commit', pushed: '已 Push', 'mr-created': 'MR 已建立' } as const)[record.state]}</p>
      {record.gate.reasons.map((reason) => <p class="warning">{reason}</p>)}<p class="diff-stat">{record.diffStat || '目前沒有差異'}</p><p class="subtle">{record.changedFiles.join(' · ')}</p><details><summary>查看預覽差異</summary><pre>{record.diff || '沒有可顯示的差異。'}</pre></details>
      {record.mergeRequestUrl && <button class="quiet" type="button" onClick={() => onOpenExternal(record.mergeRequestUrl!)}>開啟 GitLab MR</button>}
      <div class="button-row">{record.state === 'preview' && <button class="secondary" type="button" disabled={busy || !record.gate.ok} onClick={() => onAction('commitDelivery', record)}>重新驗收並 Commit</button>}{record.state === 'committed' && <button class="secondary" type="button" disabled={busy} onClick={() => onAction('pushDelivery', record)}>Push 分支</button>}{record.state === 'pushed' && <button class="primary" type="button" disabled={busy} onClick={() => onAction('createDeliveryMergeRequest', record)}>建立 GitLab MR</button>}</div>
    </div>)}
  </>;
}

export function TimeRow({ entry, edit, onEdit, onRequest }: {
  entry: WorkspaceTimerEntry; edit?: TimeEdit; onEdit: (edit: TimeEdit) => void; onRequest: (request: WorkspaceRequest) => void;
}) {
  const hours = Math.floor(entry.elapsedSeconds / 3600);
  const minutes = Math.floor(entry.elapsedSeconds % 3600 / 60);
  const seconds = entry.elapsedSeconds % 60;
  const duration = `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${seconds ? `${seconds}s` : ''}` || '1m';
  const value = edit ?? { duration, summary: entry.summary, spentAt: entry.spentAt ?? '' };
  return <div class="time-row"><span><strong>{hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`}</strong>　{entry.phase === 'needs-review' ? '重新開啟後待確認' : entry.phase === 'uncertain' ? '等待確認 GitLab 紀錄' : entry.phase === 'sending' ? '送出中' : '待送出'}</span>
    <input aria-label="工時長度" placeholder="45m" value={value.duration} onInput={(event) => onEdit({ ...value, duration: event.currentTarget.value })} />
    <input aria-label="工時摘要" placeholder="工時摘要" value={value.summary} onInput={(event) => onEdit({ ...value, summary: event.currentTarget.value })} />
    <input aria-label="工時日期" type="date" value={value.spentAt} onInput={(event) => onEdit({ ...value, spentAt: event.currentTarget.value })} />
    <button class="quiet small" type="button" onClick={() => onRequest({ type: 'updateTimeEntry', id: entry.id, ...value })}>儲存</button>
    {entry.phase === 'ready' && <button class="quiet small" type="button" onClick={() => onRequest({ type: 'submitTimeEntry', id: entry.id })}>送至 GitLab</button>}
    {entry.phase === 'uncertain' && <button class="quiet small" type="button" onClick={() => onRequest({ type: 'acknowledgeTimeEntry', id: entry.id })}>已對帳</button>}
  </div>;
}
