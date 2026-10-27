/** @jsxImportSource preact */
import type { ReviewerToolId, ReviewSessionSummary } from '../workspace/reviewSessionProtocol';

const stateLabel: Record<string, string> = {
  running: '準備證據', ready: '等待語意審查', reviewing: '審查中', validating: '驗證報告',
  published: '報告已產生', failed: '已停止', cancelled: '已取消',
};
const phaseLabel: Record<string, string> = {
  preflight: '預檢', 'local-preflight': '本機預檢', 'output-preflight': '輸出預檢',
  'branch-preflight': '確認分支', 'waiting-network': '等待同步配額', fetch: '同步指定分支',
  'ref-pinning': '固定版本', 'snapshot-capture': '封裝證據', 'waiting-pack': '等待封裝配額',
  'manifest-finalize': '整理證據', review: '語意審查', 'draft-repair': '修正草稿後續跑',
  'input-repair': '修正操作輸入後續跑', 'wrap-up': '停止新增追查並收尾',
  validation: '驗證固定證據', complete: '發布完成', terminal: '結束',
};
const budgetLabel: Record<string, string> = {
  'within-budget': '預算內審查', 'extended-investigation': '延長追查', 'wrap-up': '收尾',
  incomplete: '審查未完成', complete: '審查完成', stopped: '已停止',
};
const duration = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function ReviewSessions({ tool, sessions, error, onRefresh, onCancel, onCopyRefresh, onCopyResume, onOpenReport }: {
  tool: ReviewerToolId; sessions: ReviewSessionSummary[]; error?: string;
  onRefresh: () => void; onCancel: (id: string) => void;
  onCopyRefresh: (id: string) => void; onCopyResume: (id: string) => void; onOpenReport: (id: string) => void;
}) {
  const label = tool === 'merge-reviewer' ? '本機合併審查' : '本機上版檢查';
  return <section class="review-sessions" aria-label={label}>
    <header><h3>{label}</h3><button type="button" class="secondary" onClick={onRefresh}>更新審查狀態</button></header>
    {error ? <p role="status">{error}</p> : !sessions.length ? <p class="subtle">尚無審查紀錄。貼上提示詞執行後，這裡會顯示各份審查的進度。</p>
      : <div class="review-session-list">{sessions.map(item => <article key={item.requestId}>
        <div><strong>{item.repository}</strong><small>{item.requestId.slice(0, 8)}</small></div>
        <p>{item.head} → {item.base}</p>
        <p role="status">{stateLabel[item.state] ?? item.state} · {phaseLabel[item.phase] ?? item.phase}</p>
        {item.budget?.profile === 'balanced' && <p role="status">
          {budgetLabel[item.budget.phase]} · 已用 {duration(item.budget.elapsedSeconds)}／時間目標 {duration(item.budget.limitSeconds!)}
        </p>}
        {item.state === 'published' && <div class={item.reviewOutcome?.reviewComplete === true ? 'review-outcome' : 'review-outcome warning'}>
          <p>審查覆蓋：{item.reviewOutcome?.reviewComplete === true ? '完整' : item.reviewOutcome?.reviewComplete === false ? '未完整' : '未知'}</p>
          {!!item.reviewOutcome?.gaps.length && <ul>{item.reviewOutcome.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
          {!item.reviewOutcome && <p>發布紀錄未保存有效的審查結果摘要，無法確認初次審查完整性。</p>}
        </div>}
        <p class="subtle">遠端同步 {item.fetchCount} 次 · 物件快取 {item.packCacheHits} 份 · {new Date(item.updatedAt).toLocaleString()}</p>
        {item.baseSha && item.headSha && <p class="subtle">固定版本 {item.headSha.slice(0, 8)} → {item.baseSha.slice(0, 8)}</p>}
        {item.capturedAt && <p class="subtle">證據擷取 {new Date(item.capturedAt).toLocaleString()}</p>}
        {item.syncObservations?.map((sync, index) => <p class="subtle" key={index}>遠端觀察 {sync.mode} · {new Date(sync.at).toLocaleString()}</p>)}
        {item.error && <p class="warning">{item.error}</p>}
        {item.cleanupPending && <p class="warning">報告已保存，暫存清理待重試；恢復指令會沿用既有報告。</p>}
        <div class="review-session-actions">
          {item.reportPath && <button class="secondary" type="button" onClick={() => onOpenReport(item.requestId)}>開啟報告</button>}
          {!['published', 'failed', 'cancelled'].includes(item.state) &&
            <button class="secondary" type="button" onClick={() => onCancel(item.requestId)}>取消審查</button>}
          {(item.cleanupPending || !['published', 'failed', 'cancelled'].includes(item.state)) &&
            <button class="secondary" type="button" onClick={() => onCopyResume(item.requestId)}>複製恢復審查指令</button>}
          <button class="secondary" type="button" onClick={() => onCopyRefresh(item.requestId)}>複製重新同步指令</button>
        </div>
      </article>)}</div>}
    <p class="subtle">狀態來自本機紀錄；更新狀態不會連線 GitLab。重新同步指令貼入 Codex 執行後，才會建立新的審查。</p>
  </section>;
}
