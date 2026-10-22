/** @jsxImportSource preact */
import type { ReviewSessionSummary } from '../workspace/reviewSessionProtocol';

const stateLabel: Record<string, string> = {
  running: '準備證據', ready: '等待語意審查', reviewing: '審查中', validating: '驗證報告',
  published: '報告已產生', failed: '已停止', cancelled: '已取消',
};
const phaseLabel: Record<string, string> = {
  preflight: '預檢', 'local-preflight': '本機預檢', 'output-preflight': '輸出預檢',
  'branch-preflight': '確認分支', 'waiting-network': '等待同步配額', fetch: '同步指定分支',
  'ref-pinning': '固定版本', 'snapshot-capture': '封裝證據', 'waiting-pack': '等待封裝配額',
  'manifest-finalize': '整理證據', review: '語意審查', 'draft-repair': '修正草稿',
  validation: '驗證固定證據', complete: '完成', terminal: '結束',
};

export function ReviewSessions({ sessions, error, onRefresh, onCancel, onCopyRefresh, onOpenReport }: {
  sessions: ReviewSessionSummary[]; error?: string;
  onRefresh: () => void; onCancel: (id: string) => void;
  onCopyRefresh: (id: string) => void; onOpenReport: (id: string) => void;
}) {
  return <section class="review-sessions" aria-label="本機合併審查">
    <header><h3>本機合併審查</h3><button type="button" class="secondary" onClick={onRefresh}>更新審查狀態</button></header>
    {error ? <p role="status">{error}</p> : !sessions.length ? <p class="subtle">尚無審查紀錄。貼上提示詞執行後，這裡會顯示各份審查的進度。</p>
      : <div class="review-session-list">{sessions.map(item => <article key={item.requestId}>
        <div><strong>{item.repository}</strong><small>{item.requestId.slice(0, 8)}</small></div>
        <p>{item.head} → {item.base}</p>
        <p role="status">{stateLabel[item.state] ?? item.state} · {phaseLabel[item.phase] ?? item.phase}</p>
        <p class="subtle">遠端同步 {item.fetchCount} 次 · 物件快取 {item.packCacheHits} 份 · {new Date(item.updatedAt).toLocaleString()}</p>
        {item.error && <p class="warning">{item.error}</p>}
        <div class="review-session-actions">
          {item.reportPath && <button class="secondary" type="button" onClick={() => onOpenReport(item.requestId)}>開啟報告</button>}
          {!['published', 'failed', 'cancelled'].includes(item.state) &&
            <button class="secondary" type="button" onClick={() => onCancel(item.requestId)}>取消審查</button>}
          <button class="secondary" type="button" onClick={() => onCopyRefresh(item.requestId)}>複製重新同步指令</button>
        </div>
      </article>)}</div>}
    <p class="subtle">狀態來自本機紀錄；更新狀態不會連線 GitLab。重新同步指令貼入 Codex 執行後，才會建立新的審查。</p>
  </section>;
}
