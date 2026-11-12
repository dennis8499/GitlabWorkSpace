/** @jsxImportSource preact */
import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { usePresence } from './motion';

/** HTML modal dialog owns inertness, focus containment and Escape in real Webviews. */
export function NativeDialog({ open, presence, onClose, labelledBy, children, surfaceRef, initialFocus,
  surfaceClass = 'tool-drawer', scrimClass = '' }: {
  open: boolean; presence?: ReturnType<typeof usePresence>; onClose(): void; labelledBy: string; children: ComponentChildren;
  surfaceRef?: RefObject<HTMLElement>; initialFocus?: RefObject<HTMLElement>; surfaceClass?: string; scrimClass?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // JSDOM does not implement showModal; the fallback only supports test DOMs.
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    initialFocus?.current?.focus();
    return () => { if (element.open && typeof element.close === 'function') element.close(); };
  }, []);
  useEffect(() => {
    if (typeof dialog.current?.showModal === 'function') return;
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? [])];
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const contain = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) (initialFocus?.current ?? focusable()[0])?.focus();
    };
    document.addEventListener('keydown', keydown); document.addEventListener('focusin', contain);
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('focusin', contain); };
  }, []);
  return <dialog ref={dialog} class={`native-dialog drawer-scrim motion-overlay ${scrimClass}`} aria-labelledby={labelledBy}
    role="dialog" aria-modal="true" data-presence={presence?.phase ?? 'entered'} onAnimationEnd={presence?.onAnimationEnd}
    onCancel={event => { event.preventDefault(); close.current(); }}
    onClick={event => { if (event.target === event.currentTarget) close.current(); }}>
    <section ref={surfaceRef} class={`${surfaceClass} motion-surface`}
      onClickCapture={event => { if (!open) { event.preventDefault(); event.stopPropagation(); } }}
      onKeyDownCapture={event => { if (!open && !['Tab', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); } }}>
      {children}
    </section>
  </dialog>;
}
