/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { codexTaskActive } from '../codex/protocol';
import { codexStatusLabels, type useCodexWorkspace } from './useCodexWorkspace';

type Controller = ReturnType<typeof useCodexWorkspace>;
const historyBatchLimit = 1000;

/** The desktop rail and narrow-screen drawer offer the same history actions. */
export function CodexTaskList({ controller: c, onSelect, onClose }: { controller: Controller; onSelect(id: string): void; onClose?(): void }) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [repo, setRepo] = useState('all');
  const [archived, setArchived] = useState(false), [limit, setLimit] = useState(50), [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const roots = useMemo(() => [...new Set(c.tasks.map(task => task.origin?.repositoryRoot ?? task.root))].sort(), [c.tasks]);
  const filtered = useMemo(() => c.tasks.filter(task => (archived || !task.archived) && (repo === 'all' || (task.origin?.repositoryRoot ?? task.root) === repo)
    && (filter === 'all' || (filter === 'active' ? codexTaskActive(task.status) || task.status === 'queued' : task.status === filter))
    && (!search.trim() || `${task.title} ${task.origin?.repositoryRoot ?? task.root}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt)), [c.tasks, search, filter, repo, archived]);
  const eligible = filtered.filter(task => task.controls?.canDeleteHistory === true);
  const busy = c.deletion.taskIds.length > 0;
  const reset = () => { setLimit(50); setSelected(new Set()); };
  useEffect(() => {
    setSelected(current => {
      const next = new Set([...current].filter(id => filtered.some(task => task.id === id && task.controls?.canDeleteHistory === true)));
      return next.size === current.size ? current : next;
    });
  }, [filtered]);
  const toggle = (id: string, checked: boolean) => setSelected(current => {
    if (checked && current.size >= historyBatchLimit) return current;
    const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next;
  });
  return <nav class="codex-tasks" aria-label="Codex 任務清單">
    <header><h1>Codex</h1><span>{c.tasks.length} 項任務</span>{onClose && <button type="button" class="quiet" onClick={onClose}>關閉任務清單</button>}</header>
    <div class="codex-list-tools"><button type="button" class="primary" onClick={() => { c.post({ type: 'codexCommand', command: { action: 'create' } }); onClose?.(); }}>建立 Codex 任務</button>
      <details class="codex-list-utilities"><summary aria-label="其他 Codex 操作">其他操作</summary><div>
        <button type="button" onClick={() => { c.post({ type: 'pickCodexLaunch' }); onClose?.(); }}>繼續準備任務…</button>
        <button type="button" onClick={() => c.post({ type: 'codexCommand', command: { action: 'manage-local-connections' } })}>管理本機連線</button>
      </div></details></div>
    <label class="codex-task-filter">搜尋任務<input type="search" placeholder="搜尋名稱或 Repo…" value={search} onInput={event => { setSearch(event.currentTarget.value); reset(); }} /></label>
    <details class="codex-list-filters"><summary>篩選任務{filter !== 'all' || repo !== 'all' || archived ? ' · 已套用' : ''}</summary>
      <label class="codex-task-filter">狀態<select value={filter} onChange={event => { setFilter(event.currentTarget.value); reset(); }}>
        <option value="all">全部狀態</option><option value="active">執行／排隊中</option><option value="waiting">等待回覆</option><option value="paused">已暫停</option><option value="completed">本輪完成</option><option value="uncertain">結果待核對</option><option value="failed">失敗</option></select></label>
      <label class="codex-task-filter">Repo<select value={repo} onChange={event => { setRepo(event.currentTarget.value); reset(); }}><option value="all">全部 Repo</option>{roots.map(root => <option key={root} value={root}>{root}</option>)}</select></label>
      <label><input type="checkbox" checked={archived} onChange={event => { setArchived(event.currentTarget.checked); reset(); }} />顯示已封存</label>
    </details>
    <div class="codex-history-tools"><span>{filtered.length} 筆紀錄</span><button type="button" class="quiet small" aria-pressed={managing} disabled={busy} onClick={() => { setManaging(value => !value); setSelected(new Set()); }}>{managing ? '完成管理' : '管理紀錄'}</button></div>
    {managing && <div class="codex-history-selection"><label><input type="checkbox" checked={eligible.length > 0 && selected.size === Math.min(eligible.length, historyBatchLimit)} disabled={busy || !eligible.length}
      onChange={event => setSelected(event.currentTarget.checked ? new Set(eligible.slice(0, historyBatchLimit).map(task => task.id)) : new Set())} />選取可刪除的篩選結果（最多 1,000 筆）</label>
      <button type="button" disabled={!selected.size || busy} onClick={() => c.deleteHistory([...selected])}>{busy ? '正在刪除…' : `刪除選取紀錄（${selected.size}）`}</button>
      <p class="subtle">每次最多刪除 1,000 筆，完成後可繼續選取其餘紀錄。執行中的任務需先暫停或停止；刪除前會再次確認範圍。</p></div>}
    {!!c.environment.storageProblems?.length && <div class="warning" role="status"><p>{c.environment.storageProblems.some(problem => problem.kind !== 'cleanup') ? '紀錄待修復；新派發已暫停。' : '對話附屬資料清理待重試。'}</p>
      <details><summary>待修復紀錄</summary>{c.environment.storageProblems.map(problem => <p key={problem.id}>{problem.id}：{problem.reason}</p>)}</details>
      <button type="button" onClick={() => c.post({ type: 'codexCommand', command: { action: 'storage' } })}>開啟紀錄資料夾</button>
      <button type="button" onClick={() => c.post({ type: 'listCodexTasks' })}>重新讀取</button></div>}
    {c.deletion.message && <p class="codex-deletion-status" role="status">{c.deletion.message}</p>}
    {!!c.deletion.failures.length && <ul class="codex-deletion-failures">{c.deletion.failures.map(failure => <li key={failure.taskId}>{c.tasks.find(task => task.id === failure.taskId)?.title ?? failure.taskId}：{failure.reason}</li>)}</ul>}
    {!c.tasks.length && <p class="subtle">從 Issue、MR 或專案開始，進度與成果集中在這裡。</p>}
    <div class="codex-task-rows">{filtered.slice(0, limit).map(task => <div key={task.id} class={`codex-task-row${task.id === c.ui.selectedTaskId ? ' active' : ''}`}>
      {managing && <input type="checkbox" aria-label={`選取 ${task.title}`} checked={selected.has(task.id)} disabled={busy || task.controls?.canDeleteHistory !== true || !selected.has(task.id) && selected.size >= historyBatchLimit}
        title={task.controls?.deleteHistoryBlockedReason ?? (!selected.has(task.id) && selected.size >= historyBatchLimit ? '已選取 1,000 筆；請先刪除目前選取的紀錄。' : undefined)} onChange={event => toggle(task.id, event.currentTarget.checked)} />}
      <button type="button" class="codex-task-select" aria-current={task.id === c.ui.selectedTaskId ? 'true' : undefined} onClick={() => onSelect(task.id)}>
        <strong>{task.pinned ? '★ ' : ''}{task.title}{task.archived ? '（已封存）' : ''}</strong><span>{codexStatusLabels[task.status]}{task.controls?.external ? ' · 其他視窗' : ''}</span>
        <small class="codex-root" title={task.origin?.repositoryRoot ?? task.root}>{task.origin?.projectPath ?? (task.origin?.repositoryRoot ?? task.root).split(/[\\/]/).filter(Boolean).pop()}</small>
        <small>{new Date(task.createdAt).toLocaleString()}</small>
      </button>
      {!managing && <button type="button" class="quiet small codex-delete-history" aria-label={`刪除 ${task.title} 的執行紀錄`} disabled={busy || task.controls?.canDeleteHistory !== true}
        title={task.controls?.deleteHistoryBlockedReason ?? '刪除此擴充功能的任務與對話紀錄；保留程式與成果'} onClick={() => c.deleteHistory([task.id])}>{c.deletion.taskIds.includes(task.id) ? '刪除中…' : '刪除'}</button>}
    </div>)}</div>
    {!filtered.length && !!c.tasks.length && <p class="subtle">沒有符合篩選的任務。</p>}
    {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 50)}>顯示更多任務（{limit}/{filtered.length}）</button>}
  </nav>;
}
