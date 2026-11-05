import { useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';

export function boundedMenuPosition(anchor: { left: number; top: number; bottom: number }, width: number, height: number,
  bounds: { left: number; top: number; right: number; bottom: number }) {
  const left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8));
  const top = anchor.bottom + height + 8 <= bounds.bottom ? anchor.bottom + 4 : Math.max(bounds.top + 8, anchor.top - height - 4);
  return { left, top };
}
let menuId = 0;
/** Native browser top-layer popovers escape the Git panes' clipping boundaries. */
export function useBoundedMenus(host: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    const root = host.current;
    if (!root || !active) return;
    const menus = () => [...root.querySelectorAll<HTMLDetailsElement>('details.git-actions-menu, details.git-ref-menu')];
    const isOpen = (popup: HTMLElement) => typeof popup.showPopover === 'function' && popup.matches(':popover-open');
    const close = (details: HTMLDetailsElement, focus = false) => {
      const popup = details.querySelector<HTMLElement>('.git-actions-popup');
      if (popup && isOpen(popup)) popup.hidePopover();
      details.open = false;
      if (focus) details.querySelector<HTMLElement>('summary')?.focus();
    };
    const position = (details: HTMLDetailsElement) => {
      const popup = details.querySelector<HTMLElement>('.git-actions-popup'), summary = details.querySelector<HTMLElement>('summary');
      if (!popup || !summary) return;
      const boundary = root.getBoundingClientRect(), anchor = summary.getBoundingClientRect();
      const bounds = { left: Math.max(0, boundary.left), top: Math.max(0, boundary.top), right: Math.min(innerWidth, boundary.right), bottom: Math.min(innerHeight, boundary.bottom) };
      if (typeof popup.showPopover === 'function') { popup.popover = 'manual'; if (!isOpen(popup)) popup.showPopover(); }
      popup.style.maxWidth = `${Math.max(100, bounds.right - bounds.left - 16)}px`;
      popup.style.maxHeight = `${Math.max(80, bounds.bottom - bounds.top - 16)}px`;
      const rect = popup.getBoundingClientRect(), next = boundedMenuPosition(anchor, rect.width, rect.height, bounds);
      const topLayer = typeof popup.showPopover === 'function';
      popup.style.left = `${next.left - (topLayer ? 0 : anchor.left)}px`; popup.style.top = `${next.top - (topLayer ? 0 : anchor.top)}px`; popup.style.right = 'auto';
      popup.id ||= `git-action-menu-${++menuId}`;
      summary.setAttribute('aria-controls', popup.id); summary.setAttribute('aria-haspopup', 'menu'); popup.setAttribute('role', 'menu');
      for (const button of popup.querySelectorAll('button')) button.setAttribute('role', 'menuitem');
    };
    const toggle = (event: Event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.matches('.git-actions-menu,.git-ref-menu')) return;
      if (details.open) { for (const other of menus()) if (other !== details && other.open) close(other); position(details); }
      else { const popup = details.querySelector<HTMLElement>('.git-actions-popup'); if (popup && isOpen(popup)) popup.hidePopover(); }
    };
    const pointer = (event: PointerEvent) => { for (const details of menus()) if (details.open && !details.contains(event.target as Node)) close(details); };
    const keydown = (event: KeyboardEvent) => {
      const details = menus().find(item => item.open && item.contains(document.activeElement));
      if (!details) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(details, true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...details.querySelectorAll<HTMLButtonElement>('.git-actions-popup button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    const resize = () => { for (const details of menus()) if (details.open) position(details); };
    root.addEventListener('toggle', toggle, true); document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', keydown, true); window.addEventListener('resize', resize);
    return () => { for (const details of menus()) close(details); root.removeEventListener('toggle', toggle, true);
      document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keydown, true); window.removeEventListener('resize', resize); };
  }, [active, host]);
}
