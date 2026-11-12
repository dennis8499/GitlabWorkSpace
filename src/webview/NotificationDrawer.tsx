/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NotificationRequest, NotificationSnapshot } from '../notifications/notificationProtocol';
import type { usePresence } from './motion';
import { NativeDialog } from './NativeDialog';

export function NotificationDrawer({ snapshot, post, onClose, targetId, targetRequest, open = true, presence }: {
  snapshot?: NotificationSnapshot; post: (request: NotificationRequest) => void; onClose: () => void;
  targetId?: string; targetRequest?: number;
  open?: boolean; presence?: ReturnType<typeof usePresence>;
}) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [expanded, setExpanded] = useState(new Set<string>());
  const drawer = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const summaries = useRef(new Map<string, HTMLElement>());
  const requestedRead = useRef(new Set<string>());
  const targetHandled = useRef('');
  const markRead = (id: string) => {
    if (!open) return;
    const item = snapshot?.items.find(item => item.id === id);
    const key = `${id}:${snapshot?.revision}`;
    if (!item || item.read || requestedRead.current.has(key)) return;
    requestedRead.current.add(key);
    post({ type: 'markNotificationsRead', ids: [id], revision: snapshot?.revision ?? 0 });
  };
  useEffect(() => {
    const key = `${targetId}:${targetRequest}`;
    if (!open || !targetId || targetHandled.current === key || !snapshot?.items.some(item => item.id === targetId)) return;
    targetHandled.current = key;
    setFilter('all');
    setExpanded(current => new Set([...current, targetId]));
    markRead(targetId);
    requestAnimationFrame(() => { summaries.current.get(targetId)?.focus(); summaries.current.get(targetId)?.scrollIntoView?.({ block: 'nearest' }); });
  }, [targetId, targetRequest, snapshot, open]);
  const items = (snapshot?.items ?? []).filter(item => filter === 'all' || !item.read || expanded.has(item.id));
  const chooseFilter = (next: 'all' | 'unread') => { if (next !== filter) { setExpanded(new Set()); setFilter(next); } };
  return <NativeDialog open={open} presence={presence} onClose={onClose} labelledBy="notification-title" surfaceRef={drawer}
    initialFocus={close} surfaceClass="tool-drawer notification-drawer" scrimClass="notification-scrim">
      <div class="drawer-heading"><div><h2 id="notification-title">訊息中心</h2><p class="subtle">本次 VS Code 工作階段 · {snapshot?.unreadCount ?? 0} 筆未讀</p></div><button ref={close} class="quiet" type="button" onClick={onClose}>關閉</button></div>
      <div class="notification-controls"><div role="group" aria-label="訊息篩選"><button type="button" aria-pressed={filter === 'all'} onClick={() => chooseFilter('all')}>全部</button><button type="button" aria-pressed={filter === 'unread'} onClick={() => chooseFilter('unread')}>未讀</button></div>
        <button class="quiet" type="button" disabled={!snapshot?.unreadCount} onClick={() => snapshot && post({ type: 'markAllNotificationsRead', revision: snapshot.revision })}>全部已讀</button>
        <button class="quiet" type="button" disabled={!snapshot?.items.length} onClick={() => snapshot && post({ type: 'clearNotifications', revision: snapshot.revision })}>清除全部</button></div>
      {!items.length && <p class="empty-inline notification-empty">{filter === 'unread' ? '沒有未讀訊息。' : '目前沒有訊息。'}</p>}
      <ul class="notification-list">{items.map(item => <li key={item.id} class={`notification-item ${item.level}${item.read ? '' : ' unread'}`}>
        <details open={expanded.has(item.id)} onToggle={event => {
          const open = event.currentTarget.open;
          setExpanded(current => { if (current.has(item.id) === open) return current; const next = new Set(current); if (open) next.add(item.id); else next.delete(item.id); return next; });
          if (open) markRead(item.id);
        }}>
          <summary ref={element => { if (element) summaries.current.set(item.id, element); else summaries.current.delete(item.id); }}><span class="notification-level">{item.level === 'error' ? '錯誤' : item.level === 'warn' ? '警告' : '資訊'}</span><strong>{item.title}</strong>{!item.read && <span class="notification-unread">未讀</span>}<time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleTimeString()}</time><span class="notification-preview">{item.messages.at(-1)}</span></summary>
          <div class="notification-detail">{item.messages.map((message, index) => <p key={index}>{message}</p>)}
            <div class="button-row">
              <button type="button" onClick={() => { post({ type: 'openNotificationTarget', id: item.id, destination: 'origin' }); onClose(); }}>{item.target?.kind === 'task' ? '開啟任務' : item.target?.kind === 'issue' ? '返回 Issue' : item.target?.kind === 'mergeRequest' ? '開啟 MR' : item.target?.kind === 'tools' ? '修復環境' : '查看 Log'}</button>
              {item.target && item.target.kind !== 'logs' && <button class="quiet" type="button" onClick={() => post({ type: 'openNotificationTarget', id: item.id, destination: 'logs' })}>查看 Log</button>}
            </div>
            {item.origin && <p class="subtle notification-origin">{[item.origin.baseUrl, item.origin.accountId && `帳號 ${item.origin.accountId}`, item.origin.groupId && `Group ${item.origin.groupId}`, item.origin.root].filter(Boolean).join(' · ')}</p>}
          </div>
        </details><button class="quiet notification-remove" type="button" aria-label={`移除訊息：${item.title}`} onClick={() => post({ type: 'removeNotification', id: item.id })}>移除</button>
      </li>)}</ul>
  </NativeDialog>;
}
