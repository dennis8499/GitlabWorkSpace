/** @jsxImportSource preact */
import type { GitLabIssue } from '../api/types';
import type { WorkspaceRequest, WorkspaceTimerEntry } from '../workspace/workspaceProtocol';


export interface TimeEdit { duration: string; summary: string; spentAt: string; }


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
