/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { GitLabAccount } from '../connection/accountProtocol';
import type { LogPage, LogQuery, OperationLogEntry } from '../logging/logProtocol';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';

const featureLabels: Record<string, string> = { workspace: '工作台', account: '帳號', group: 'Group', issue: 'Issue', time: '工時', projects: '專案與掃描', analysis: '分析', git: 'Git 指令／版控', api: 'GitLab API', workflow: 'MR 與交付', tools: '工具套件' };
const resultLabels = { started: '開始', success: '成功', error: '失敗', cancelled: '取消' };

export function AdminLogPanel({ accounts, post }: { accounts: GitLabAccount[]; post: (request: WorkspaceRequest) => void }) {
  const [query, setQuery] = useState<LogQuery>({ page: 0 });
  const [data, setData] = useState<LogPage>();
  const [detail, setDetail] = useState<OperationLogEntry>();
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const latest = useRef('');
  const busy = useRef(false);
  const changed = useRef(false);
  const request = useCallback(() => {
    const requestId = 'logs-' + ++sequence.current;
    latest.current = requestId; busy.current = true; changed.current = false; setLoading(true);
    post({ type: 'queryLogs', requestId, query });
  }, [query, post]);
  useEffect(() => {
    const receive = (event: MessageEvent<WorkspaceResponse>) => {
      if (event.data?.type === 'logsPage' && event.data.requestId === latest.current) {
        setData(event.data.page); busy.current = false; setLoading(false);
        if (changed.current && live) request();
      } else if (event.data?.type === 'logsChanged' && live) {
        if (busy.current) changed.current = true;
        else request();
      }
    };
    window.addEventListener('message', receive);
    post({ type: 'setLogVisibility', visible: live }); request();
    return () => { window.removeEventListener('message', receive); post({ type: 'setLogVisibility', visible: false }); };
  }, [request, live, post]);
  const filter = (patch: Partial<LogQuery>) => { setDetail(undefined); setQuery(current => ({ ...current, ...patch, page: 0 })); };
  const accountLabel = (id?: string) => accounts.find(account => account.id === id)?.name ?? (id ? '已移除帳號' : '本機／未登入');
  const archivedAccounts = (data?.accounts ?? []).filter(account => !accounts.some(saved => saved.id === account.id));
  return <section class="admin-log-panel" aria-label="GitLab Workspace Log">
    <div class="log-filters">
      <label>功能<select aria-label="Log 功能" value={query.feature ?? ''} onChange={event => filter({ feature: event.currentTarget.value })}><option value="">全部功能</option>{Object.entries(featureLabels).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
      <label>帳號<select aria-label="Log 帳號" value={query.accountId ?? ''} onChange={event => filter({ accountId: event.currentTarget.value })}><option value="">全部帳號</option>{accounts.map(account => <option value={account.id}>{account.name || account.username} · {account.baseUrl}</option>)}{archivedAccounts.map(account => <option value={account.id}>已移除 · {account.baseUrl} · {account.id.slice(0, 8)}</option>)}</select></label>
      <label>等級<select aria-label="Log 等級" value={query.level ?? ''} onChange={event => filter({ level: event.currentTarget.value as LogQuery['level'] })}><option value="">全部等級</option><option value="info">資訊</option><option value="warn">警告</option><option value="error">錯誤</option></select></label>
      <label>結果<select aria-label="Log 結果" value={query.result ?? ''} onChange={event => filter({ result: event.currentTarget.value as LogQuery['result'] })}><option value="">全部結果</option>{Object.entries(resultLabels).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
      <label>從<input aria-label="Log 開始時間" type="datetime-local" onChange={event => filter({ from: event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : undefined })} /></label>
      <label>到<input aria-label="Log 結束時間" type="datetime-local" onChange={event => filter({ to: event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : undefined })} /></label>
      <label class="log-search">搜尋<input aria-label="搜尋 Log" type="search" value={query.search ?? ''} placeholder="操作、端點、Repo 或錯誤…" onInput={event => filter({ search: event.currentTarget.value })} /></label>
    </div>
    <div class="toolbar log-actions"><label><input type="checkbox" checked={live} onChange={event => setLive(event.currentTarget.checked)} /> 即時更新</label><button type="button" onClick={request}>重新整理 Log</button><button type="button" onClick={() => post({ type: 'exportLogs', query })}>匯出篩選結果</button><button class="danger" type="button" onClick={() => post({ type: 'clearLogs' })}>清除全部 Log</button><span role="status">{loading ? '讀取中…' : `${data?.total ?? 0} 筆紀錄`}</span></div>
    <p class="subtle">本機紀錄保留 30 天，最多 50 MB。各操作的 API 與 Git 摘要可透過操作 ID 對照。</p>
    {data?.error && <div class="alert" role="alert">{data.error}</div>}
    <div class="log-table-scroll"><table class="log-table"><thead><tr><th>時間</th><th>功能／操作</th><th>帳號</th><th>結果</th><th>耗時</th></tr></thead><tbody>{data?.entries.map(entry => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td><button class="status-link" type="button" onClick={() => setDetail(entry)}>{featureLabels[entry.feature] ?? entry.feature} · {entry.action}</button>{entry.message && <small>{entry.message}</small>}</td><td title={entry.baseUrl}>{accountLabel(entry.accountId)}</td><td><span class={`pill ${entry.result === 'error' ? 'danger' : entry.result === 'success' ? 'success' : ''}`}>{resultLabels[entry.result]}</span>{entry.statusCode !== undefined && <small>HTTP {entry.statusCode}</small>}</td><td>{entry.durationMs !== undefined ? `${entry.durationMs} ms` : '—'}</td></tr>)}</tbody></table>{!loading && !data?.entries.length && <p class="empty-inline">沒有符合條件的 Log。</p>}</div>
    <div class="toolbar log-pagination"><button type="button" disabled={!query.page} onClick={() => setQuery(current => ({ ...current, page: (current.page ?? 0) - 1 }))}>上一頁</button><span>第 {(query.page ?? 0) + 1} 頁 · 每頁 100 筆</span><button type="button" disabled={!data || ((query.page ?? 0) + 1) * 100 >= data.total} onClick={() => setQuery(current => ({ ...current, page: (current.page ?? 0) + 1 }))}>下一頁</button></div>
    {detail && <section class="log-detail" aria-label="Log 詳情"><div class="toolbar"><strong>操作詳情</strong><button type="button" onClick={() => setDetail(undefined)}>關閉詳情</button></div><pre>{JSON.stringify(detail, null, 2)}</pre></section>}
  </section>;
}
