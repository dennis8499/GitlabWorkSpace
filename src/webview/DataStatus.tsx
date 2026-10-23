/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';

interface ReadStatus { dataSource?: 'cache' | 'network' | 'mixed'; fetchedAt?: number; expiresAt?: number; }
interface TransportState { transportStage?: 'waiting' | 'sending' | 'cooldown'; retryAt?: number; }

/** Timers change presentation only and never dispatch an action. Hidden views stop ticking. */
function useVisibleClock(until?: number, countdown = false): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      const current = Date.now(); setNow(current);
      if (document.hidden || !until || until <= current) return;
      timer = window.setTimeout(update, countdown ? Math.min(1000, until - current) : Math.min(2_147_483_647, until - current));
    };
    update(); document.addEventListener('visibilitychange', update);
    return () => { if (timer !== undefined) window.clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [until, countdown]);
  return now;
}

export function DataFreshness({ status }: { status: ReadStatus }) {
  const now = useVisibleClock(status.expiresAt);
  if (!status.dataSource && !status.fetchedAt) return null;
  const labels = { cache: '使用快取', network: '已向 GitLab 讀取', mixed: '快取與 GitLab 資料' };
  const expired = !!status.expiresAt && status.expiresAt <= now;
  return <small class="data-freshness" data-source={status.dataSource}>
    {status.dataSource && <span>{labels[status.dataSource]}</span>}
    {status.fetchedAt && <time dateTime={new Date(status.fetchedAt).toISOString()}>資料取得於 {new Date(status.fetchedAt).toLocaleTimeString()}</time>}
    {expired && <span>下次需要時更新</span>}
  </small>;
}

export function TransportStatus({ status, service = 'api' }: { status: TransportState; service?: 'api' | 'git' }) {
  const now = useVisibleClock(status.transportStage === 'cooldown' ? status.retryAt : undefined, true);
  if (!status.transportStage) return null;
  const remaining = Math.max(0, Math.ceil(((status.retryAt ?? now) - now) / 1000));
  return <span class="transport-status" data-transport-stage={status.transportStage}>
    <span>{status.transportStage === 'waiting' ? service === 'git' ? '等待 Git 網路槽位' : '等待 GitLab 請求額度'
      : status.transportStage === 'sending' ? service === 'git' ? '正在連線 Git Server' : '正在傳送 GitLab 請求'
        : remaining ? 'GitLab 要求暫停' : 'GitLab 暫停時間已到'}</span>
    {status.transportStage === 'cooldown' && status.retryAt && remaining > 0 && <time aria-live="off" dateTime={new Date(status.retryAt).toISOString()}> · {remaining} 秒後可重試（{new Date(status.retryAt).toLocaleTimeString()}）</time>}
  </span>;
}
