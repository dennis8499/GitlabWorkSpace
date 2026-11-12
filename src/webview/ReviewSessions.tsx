/** @jsxImportSource preact */
import { reviewSessionActions, type ReviewerToolId, type ReviewSessionSummary } from '../workspace/reviewSessionProtocol';

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
  'publication-repair': '修復報告輸出後續跑',
  validation: '驗證固定證據', complete: '發布完成', terminal: '結束',
};
const budgetLabel: Record<string, string> = {
  'within-budget': '預算內審查', 'extended-investigation': '延長追查', 'wrap-up': '收尾',
  incomplete: '審查未完成', complete: '審查完成', stopped: '已停止',
};
const validationCategoryLabel: Record<string, string> = { repositories: 'Repo', contracts: '契約', searches: '搜尋' };
const validationActivityLabel: Record<string, string> = {
  'source-prefetch': '來源預讀', 'search-prefetch': '搜尋預讀', repositories: 'Repo 核對',
  contracts: '契約核對', searches: '搜尋重驗', complete: '驗證完成',
};
const duration = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function ReviewSessions({ tool, sessions, error, onRefresh, onCancel, onCopyRefresh, onCopyResume, onOpenReport, onRun }: {
  tool: ReviewerToolId; sessions: ReviewSessionSummary[]; error?: string;
  onRun?: (id: string, action: 'resume' | 'refresh') => void;
  onRefresh: () => void; onCancel: (id: string) => void;
  onCopyRefresh: (id: string) => void; onCopyResume: (id: string) => void; onOpenReport: (id: string) => void;
}) {
  const label = tool === 'merge-reviewer' ? '本機合併審查' : '本機上版檢查';
  return <section class="review-sessions" aria-label={label}>
    <header><h3>{label}</h3><button type="button" class="secondary" onClick={onRefresh}>更新審查狀態</button></header>
    {error ? <p role="status">{error}</p> : !sessions.length ? <p class="subtle">尚無審查紀錄。使用 Codex 執行後，這裡會顯示各份審查的進度。</p>
      : <div class="review-session-list">{sessions.map(item => <article key={item.requestId}>
        <div><strong>{item.repository}</strong><small>{item.requestId.slice(0, 8)}</small></div>
        <p>{item.head} → {item.base}</p>
        <p role="status">{stateLabel[item.state] ?? item.state} · {phaseLabel[item.phase] ?? item.phase}</p>
        {item.progress && (item.progress.validation || item.progress.stage === 'validation' || item.progress.stage === 'evidence-recheck') ? <p class="subtle">
          {item.progress.stage === 'evidence-recheck' ? '固定證據重驗' : '固定證據驗證'} {item.progress.completed}/{item.progress.total}
          {Object.entries(item.progress.validation ?? {}).map(([key, count]) =>
            ` · ${validationCategoryLabel[key]} ${count.completed}/${count.total}`).join('')}
          {item.progress.activity && validationActivityLabel[item.progress.activity]
            ? ` · ${validationActivityLabel[item.progress.activity]}` : ''}
        </p> : item.progress && <p class="subtle">證據操作 {item.progress.completed}/{item.progress.total}{item.progress.operationId ? ` · ${item.progress.operationId}` : ' · 目前沒有執行中的操作'}</p>}
        {item.remaining && <p class="subtle">最近檢查待完成：{Object.entries(item.remaining).map(([key, count]) =>
          `${({ changes: '變更', boundaries: '邊界', parents: '合併來源', impacts: '影響節點', repositories: 'Repo' } as Record<string, string>)[key]} ${count}`).join(' · ')}
          {item.lastCheckAt ? `（${new Date(item.lastCheckAt).toLocaleString()}）` : ''}</p>}
        {item.budget?.profile === 'balanced' && <p role="status">
          {budgetLabel[item.budget.phase]} · 已用 {duration(item.budget.elapsedSeconds)}／時間目標 {duration(item.budget.limitSeconds!)}
        </p>}
        {item.state === 'published' && <div class={item.reviewOutcome?.reviewComplete === true ? 'review-outcome' : 'review-outcome warning'}>
          <p>審查覆蓋：{item.reviewOutcome?.reviewComplete === true ? '完整' : item.reviewOutcome?.reviewComplete === false ? '未完整' : '未知'}</p>
          {!!item.reviewOutcome?.gaps.length && <ul>{item.reviewOutcome.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
          {!item.reviewOutcome && <p>發布紀錄未保存有效的審查結果摘要，無法確認初次審查完整性。</p>}
        </div>}
        <details class="review-session-diagnostics"><summary>版本與診斷</summary><p class="subtle">遠端同步 {item.fetchCount} 次 · 物件快取 {item.packCacheHits} 份 · {new Date(item.updatedAt).toLocaleString()}</p>
        {item.baseSha && item.headSha && <p class="subtle">固定版本 {item.headSha.slice(0, 8)} → {item.baseSha.slice(0, 8)}</p>}
        {item.capturedAt && <p class="subtle">證據擷取 {new Date(item.capturedAt).toLocaleString()}</p>}
        {item.syncObservations?.map((sync, index) => <p class="subtle" key={index}>遠端觀察 {sync.mode} · {new Date(sync.at).toLocaleString()}</p>)}</details>
        {item.error && <p class="warning">{item.error}</p>}
        {item.recovery?.terminal && <p class="subtle">此 request 已終止，保留診斷供檢視；重新同步會建立新的審查。{item.retainedContext ? '固定證據仍保留，可清理診斷暫存。' : ''}</p>}
        {item.cleanupPending && <p class="warning">報告已保存，暫存清理待重試；恢復指令會沿用既有報告。</p>}
        <div class="review-session-actions">
          {item.reportPath ? <button class="primary" type="button" onClick={() => onOpenReport(item.requestId)}>開啟報告</button>
            : onRun && reviewSessionActions(item).resume && <button class="primary" type="button" onClick={() => onRun(item.requestId, 'resume')}>{item.cleanupPending ? '使用 Codex 重試清理' : '使用 Codex 恢復審查'}</button>}
          {reviewSessionActions(item).cancel &&
            <button class="secondary" type="button" onClick={() => onCancel(item.requestId)}>{item.recovery?.terminal && item.retainedContext ? '清理診斷暫存' : '取消審查'}</button>}
          <details class="workflow-alternatives"><summary>其他操作</summary>
          {onRun && <>{item.reportPath && reviewSessionActions(item).resume && <button type="button" onClick={() => onRun(item.requestId, 'resume')}>{item.cleanupPending ? '使用 Codex 重試清理' : '使用 Codex 恢復審查'}</button>}<button type="button" onClick={() => onRun(item.requestId, 'refresh')}>使用 Codex 重新同步</button></>}
          {reviewSessionActions(item).resume &&
            <button class="secondary" type="button" onClick={() => onCopyResume(item.requestId)}>複製恢復審查指令</button>}
          <button class="secondary" type="button" onClick={() => onCopyRefresh(item.requestId)}>複製重新同步指令</button>
          <p class="subtle">恢復沿用固定證據；重新同步會建立新的審查。</p></details>
        </div>
      </article>)}</div>}
    <p class="subtle">狀態來自本機紀錄；更新狀態不會連線 GitLab。重新同步會建立新的審查；恢復沿用同份固定證據。</p>
  </section>;
}
