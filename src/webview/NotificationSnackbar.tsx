/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NotificationSnapshot, WorkspaceNotification } from '../notifications/notificationProtocol';
import { usePresence } from './motion';

interface QueuedNotification { key: string; item: WorkspaceNotification; }
const duration = 6000;

function contentKey(item: WorkspaceNotification): string {
  // Older saved fixtures may predate contentRevision. Read-state updates never change this key.
  return `${item.id}:${item.contentRevision ?? JSON.stringify([item.level, item.title, item.messages, item.origin])}`;
}

export function NotificationSnackbar({ snapshot, onView }: {
  snapshot?: NotificationSnapshot; onView: (id: string) => void;
}) {
  const [queue, setQueue] = useState<QueuedNotification[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const latest = useRef(snapshot); latest.current = snapshot;
  const baseline = useRef<{ session?: string; seen: Map<string, string> }>({ seen: new Map() });
  const timing = useRef({ key: '', remaining: duration });
  const active = queue[0];
  const retained = useRef<QueuedNotification>();
  if (active) retained.current = active;
  const presence = usePresence(!!active, { durationMs: 160, immediate: document.hidden, resetKey: snapshot?.sessionId,
    onExited: () => { retained.current = undefined; } });
  const shown = active ?? retained.current;
  const dismiss = () => setQueue(current => current.slice(1));

  useEffect(() => {
    if (!snapshot) return;
    const seen = new Map(snapshot.items.map(item => [item.id, contentKey(item)]));
    const previous = baseline.current;
    const newSession = previous.session !== snapshot.sessionId;
    const hydrate = newSession || document.hidden;
    baseline.current = { session: snapshot.sessionId, seen };
    setQueue(current => {
      const retained = newSession || document.hidden ? [] : current.filter(entry => seen.has(entry.item.id));
      if (hydrate) return retained;
      const additions = [...snapshot.items].reverse().filter(item => previous.seen.get(item.id) !== seen.get(item.id))
        .map(item => ({ key: contentKey(item), item }));
      return [...retained, ...additions.filter(entry => !retained.some(existing => existing.key === entry.key))];
    });
  }, [snapshot]);

  useEffect(() => {
    const visibility = () => {
      const current = latest.current;
      if (current) baseline.current = { ...baseline.current, session: current.sessionId,
        seen: new Map(current.items.map(item => [item.id, contentKey(item)])) };
      setQueue([]);
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (timing.current.key !== active.key) timing.current = { key: active.key, remaining: duration };
    if (hovered || focused || document.hidden) return;
    const started = Date.now();
    const timer = window.setTimeout(() => setQueue(current => current[0]?.key === active.key ? current.slice(1) : current), timing.current.remaining);
    return () => {
      window.clearTimeout(timer);
      if (timing.current.key === active.key) timing.current.remaining = Math.max(0, timing.current.remaining - (Date.now() - started));
    };
  }, [active?.key, hovered, focused]);

  // Queue replacements reuse the actions, so focus and hover still pause the next message.
  useEffect(() => { if (!active) { setHovered(false); setFocused(false); } }, [active?.key]);

  if (!presence.present || !shown) return null;
  return <div class={`notification-snackbar motion-snackbar ${shown.item.level}`} data-presence={presence.phase} onAnimationEnd={presence.onAnimationEnd} role="region" aria-label="最新訊息"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusIn={() => setFocused(true)} onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <div class="notification-snackbar-content" role="status" aria-live="polite" aria-atomic="true">
      <strong>{shown.item.title}</strong><span>{shown.item.messages.at(-1)}</span>
    </div>
    <div class="notification-snackbar-actions"><button type="button" disabled={!active} onClick={() => { onView(shown.item.id); dismiss(); }}>查看</button>
      <button class="quiet" type="button" disabled={!active} onClick={dismiss}>關閉</button></div>
  </div>;
}
