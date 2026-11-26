/** @jsxImportSource preact */
import type { CodexCliRunState, CodexCliRunSummary } from '../codex/cliProtocol';

const labels: Record<CodexCliRunState, string> = {
  preparing: '準備中',
  'waiting-for-enter': '等待在終端按 Enter',
  running: '執行中',
  failed: '失敗',
  unconfirmed: '待核對',
  resetting: '重設中'
};

export function CodexCliRuns({ runs, onReset, onShow }: {
  runs: readonly CodexCliRunSummary[];
  onReset: (id: string) => void;
  onShow: (id: string) => void;
}) {
  if (!runs.length) return null;
  return <section class="codex-cli-runs" aria-label="Codex CLI 執行">
    {runs.map(run => <article key={run.runId}>
      <div><strong>{run.title}</strong><span role="status">{labels[run.state]}</span>
        {run.error && <p class="warning">{run.error}</p>}</div>
      <div class="button-row">
        {run.terminalAvailable && <button class="quiet small" type="button" aria-label={`查看 ${run.title} 終端`}
          onClick={() => onShow(run.runId)}>查看終端</button>}
        {(run.state === 'failed' || run.state === 'unconfirmed') && <button class="secondary small" type="button"
          aria-label={`重設 ${run.title}`} onClick={() => onReset(run.runId)}>重設</button>}
      </div>
    </article>)}
  </section>;
}
