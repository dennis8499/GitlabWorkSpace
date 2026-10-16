/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NotificationRequest, NotificationSnapshot } from '../notifications/notificationProtocol';

export function NotificationDrawer({ snapshot, post, onClose }: {
  snapshot?: NotificationSnapshot; post: (request: NotificationRequest) => void; onClose: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [expanded, setExpanded] = useState(new Set<string>());
  const drawer = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = [...(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]') ?? [])];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);
  const items = (snapshot?.items ?? []).filter(item => filter === 'all' || !item.read || expanded.has(item.id));
  const chooseFilter = (next: 'all' | 'unread') => { if (next !== filter) { setExpanded(new Set()); setFilter(next); } };
  return <div class="drawer-scrim notification-scrim" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={drawer} class="tool-drawer notification-drawer" role="dialog" aria-modal="true" aria-labelledby="notification-title">
      <div class="drawer-heading"><div><h2 id="notification-title">訊息中心</h2><p class="subtle">本次 VS Code 工作階段 · {snapshot?.unreadCount ?? 0} 筆未讀</p></div><button ref={close} class="quiet" type="button" onClick={onClose}>關閉</button></div>
      <div class="notification-controls"><div role="group" aria-label="訊息篩選"><button type="button" aria-pressed={filter === 'all'} onClick={() => chooseFilter('all')}>全部</button><button type="button" aria-pressed={filter === 'unread'} onClick={() => chooseFilter('unread')}>未讀</button></div>
        <button class="quiet" type="button" disabled={!snapshot?.unreadCount} onClick={() => snapshot && post({ type: 'markAllNotificationsRead', revision: snapshot.revision })}>全部已讀</button>
        <button class="quiet" type="button" disabled={!snapshot?.items.length} onClick={() => snapshot && post({ type: 'clearNotifications', revision: snapshot.revision })}>清除全部</button></div>
      {!items.length && <p class="empty-inline notification-empty">{filter === 'unread' ? '沒有未讀訊息。' : '目前沒有訊息。'}</p>}
      <ul class="notification-list">{items.map(item => <li key={item.id} class={`notification-item ${item.level}${item.read ? '' : ' unread'}`}>
        <details open={expanded.has(item.id)} onToggle={event => {
          const open = event.currentTarget.open;
          setExpanded(current => { if (current.has(item.id) === open) return current; const next = new Set(current); if (open) next.add(item.id); else next.delete(item.id); return next; });
          if (open && !item.read) post({ type: 'markNotificationsRead', ids: [item.id], revision: snapshot?.revision ?? 0 });
        }}>
          <summary><span class="notification-level">{item.level === 'error' ? '錯誤' : item.level === 'warn' ? '警告' : '資訊'}</span><strong>{item.title}</strong>{!item.read && <span class="notification-unread">未讀</span>}<time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleTimeString()}</time><span class="notification-preview">{item.messages.at(-1)}</span></summary>
          <div class="notification-detail">{item.messages.map((message, index) => <p key={index}>{message}</p>)}
            {item.origin && <p class="subtle notification-origin">{[item.origin.baseUrl, item.origin.accountId && `帳號 ${item.origin.accountId}`, item.origin.groupId && `Group ${item.origin.groupId}`, item.origin.root].filter(Boolean).join(' · ')}</p>}
          </div>
        </details><button class="quiet notification-remove" type="button" aria-label={`移除訊息：${item.title}`} onClick={() => post({ type: 'removeNotification', id: item.id })}>移除</button>
      </li>)}</ul>
    </aside>
  </div>;
}
